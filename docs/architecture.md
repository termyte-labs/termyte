# Architecture

This page describes the moving parts. For a one-screen overview, see the [README](../README.md#how-it-works) diagram.

## Components

```
                          ┌──────────────────────────┐
                          │ Coding agent             │
                          │ (Claude Code, Codex, …)  │
                          └────────────┬─────────────┘
                                       │ hook events (JSON on stdin)
                                       ▼
                          ┌──────────────────────────┐
                          │ termyte-hook             │
                          │  ├─ PlatformAdapter      │
                          │  ├─ event Handler        │
                          │  └─ formatOutput         │
                          └────────────┬─────────────┘
                                       │ NormalizedEvent
                                       ▼
                          ┌──────────────────────────┐
                          │ Ingestor → Store         │
                          │ (single SQLite insert)   │
                          └────────────┬─────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              ▼                        ▼                         ▼
        ┌───────────┐           ┌────────────┐            ┌────────────┐
        │ sessions  │           │ traces     │            │ (on Stop)  │
        └───────────┘           │ raw events │            │ handler    │
                                └─────┬──────┘            │ injects    │
                                      │                   │ context    │
                                      ▼                   └────────────┘
                          ┌──────────────────────────┐
                          │ termyte synth            │
                          │  ├─ Batcher              │
                          │  ├─ AgentAdapter         │
                          │  └─ parseAgentXml        │
                          └────────────┬─────────────┘
                                       │
                                       ▼
                          ┌──────────────────────────┐
                          │ observations + memories  │
                          │  (FTS5 + sqlite-vec)     │
                          └────────────┬─────────────┘
                                       │
              ┌────────────────────────┼─────────────────────────┐
              ▼                        ▼                         ▼
        ┌────────────┐         ┌────────────┐            ┌────────────┐
        │ termyte    │         │ termyte    │            │ termyte mcp│
        │ search     │         │ context    │            │ (stdio)    │
        └────────────┘         └────────────┘            └────────────┘
```

## Module map

| Module | Path | Responsibility |
|---|---|---|
| Public API | `src/index.ts` | Re-exports types, classes, and the `createTermyte()` factory. |
| Core types | `src/core/types.ts` | `Trace`, `Observation`, `Memory`, `Summary`, `Session`. |
| Platform adapters | `src/capture/<agent>.ts` | `normalize()` raw hook payloads into `NormalizedEvent`. |
| Ingestor | `src/capture/ingest.ts` | Validate + insert a `NormalizedEvent` into SQLite. |
| Hook driver | `src/cli/hook.ts` | `termyte-hook <platform> <event>`. Reads stdin, calls the adapter + handler. |
| Event handlers | `src/cli/handlers/<event>.ts` | Per-event handlers: `session-init`, `context`, `file-context`, `observation`, `file-edit`, `summarize`. |
| Store | `src/storage/store.ts` | Full CRUD for all five tables. |
| Migrations | `src/storage/migrations.ts` | Idempotent schema DDL + column-level migrations. |
| Legacy observer | `src/observer/pipeline.ts` | Deprecated in-process LLM observer. Superseded by `termyte synth`. |
| Synth batcher | `src/synth/batcher.ts` | Reads unprocessed traces, dispatches to an `AgentAdapter`, parses XML output. |
| Agent adapters | `src/synth/<agent>.ts` | Wrap each agent's documented CLI / SDK. |
| Spend + budget | `src/synth/spend.ts`, `src/synth/rate-limit.ts` | Daily caps, rate limiting, persistent cost log. |
| FTS5 search | `src/retrieval/fts.ts` | Keyword search over `observations_fts` and `memories_fts`. |
| Vector search | `src/retrieval/vector.ts` | Cosine similarity via the in-memory loader (sqlite-vec optional). |
| Hybrid search | `src/retrieval/hybrid.ts` | RRF fusion (k=60) + file-aware boosting. |
| Local embeddings | `src/retrieval/local-embeddings.ts` | `@xenova/transformers` ONNX runtime; Nomic or BGE. |
| Context builder | `src/context/builder.ts` | Renders markdown for `termyte context` and the MCP `search_memories` tool. |
| MCP server | `src/mcp/server.ts` | JSON-RPC 2.0 over stdio; tools: `search_memories`, `get_memory`, `get_recent_sessions`, `get_session`, `get_observations_for_session`. |
| Installers | `src/integrations/installers/<agent>.ts` | Per-agent config writers + backup. |
| OpenCode plugin | `src/integrations/opencode-plugin/index.ts` | Forwards OpenCode events to `termyte-hook`. |

## The capture path (in-process)

The capture path is the part that runs **inside the agent's process** on every hook event. It must be fast — the agent is waiting for the hook to return.

1. The agent fires a hook (e.g. Claude Code's `PostToolUse`) and pipes the JSON payload into `termyte-hook <platform> [event]` on stdin.
2. `termyte-hook` picks the right `PlatformAdapter` from the `Platform` enum.
3. The adapter's `normalize()` converts the agent-specific shape into the shared `NormalizedEvent`. Unknown / malformed payloads return `null` (the hook is a no-op) or throw `AdapterRejectedInput` (logged to stderr).
4. The optional event handler runs. Lean handlers (`observation`, `summarize`, `file-edit`) only touch the DB. Fat handlers (`context`, `session-init`, `file-context`) lazily load the embeddings model.
5. The handler returns a `HookResult` which the adapter's `formatOutput()` re-wraps into the agent's response envelope (Claude Code reads JSON, Cursor reads its own shape, etc.).
6. The formatted output is written to stdout for the agent to consume.

The capture path never blocks on the LLM. Synthesis is always async.

## The synthesis path (separate process)

The synthesis path is the part that turns traces into memories. It runs as `termyte synth` (or `termyte-worker` for the legacy in-process path). It is bounded so it can never eat the user's LLM plan.

1. `Batcher.runOnce()` reads unprocessed traces via `Store.getUnprocessedTraces(limit)`. A partial index `idx_traces_unprocessed` makes the lookup cheap.
2. The batch is wrapped in a prompt (see `src/synth/prompts.ts`).
3. The configured `AgentAdapter.invoke()` runs the prompt against the user's coding agent's LLM. The adapter respects `maxBudgetUsd` (where the underlying CLI supports it) and `timeoutMs`.
4. The LLM's text response is parsed by `parseAgentXml` (see `src/observer/parser.ts`). The parser handles code fences and falls back to `fact` for unknown observation types.
5. Each parsed observation is inserted via `Store.insertObservation(...)`. The traces are then marked processed via `Store.markTracesProcessed(...)`. The ordering is important: observations are written **before** the traces are marked processed, so a crash mid-batch leaves the trace unprocessed and re-processable on the next run.
6. The Batcher moves on to the next batch up to `maxBatches` (default 5) times per `runOnce` call.

A `Batcher` is pure orchestration. All agent-specific behavior — locating the binary, formatting flags, parsing the response — lives in the `AgentAdapter`. To support a new agent, write a new `AgentAdapter`; no changes to the Batcher are required.

A `Spend` module (`src/synth/spend.ts`) tracks daily invocation counts, input/output tokens, and an estimated cost, and refuses new invocations once the daily cap is hit. The cap is configurable via `TERMYTE_SYNTH_DAILY_BUDGET_INVOCATIONS` and `TERMYTE_SYNTH_DAILY_BUDGET_USD`.

## The retrieval path

The retrieval path is the part that runs when the user (or an MCP client) asks "what do we know about X?".

1. `HybridSearch.search({ query, limit, repo_id, currentFiles, type })` runs.
2. `FTSSearch` returns keyword matches from `memories_fts`, capped at `limit * 2`.
3. `VectorSearch` is given a candidate set pre-filtered by FTS5 (top 200) and ranks them by cosine similarity. File-aware boosting is applied here: a memory whose `files_read` / `files_modified` intersects `currentFiles` is boosted.
4. The two rank lists are fused with **Reciprocal Rank Fusion** (k=60). FTS-only results are returned cleanly when embeddings are unavailable — the `HybridSearch` catches the `NotReadyError` and degrades gracefully.
5. `ContextBuilder.renderContext` (or `renderHybridResults`) turns the result list into markdown for the agent prompt or the CLI.

## SQLite layout

The database is a single file. Five tables + two FTS5 mirrors + an optional sqlite-vec virtual table.

```
sessions
  id, session_id, project, repo_id, workspace_root, started_at, ended_at

traces
  id, session_id, timestamp, event_type, tool_name, tool_input, tool_output,
  files_read, files_modified, user_prompt, final_response, processed_at,
  ingest_status, ingest_error, ingest_attempts

observations
  id, session_id, repo_id, workspace_root, type, title, description,
  files_read, files_modified, commands_executed, source_trace_ids,
  created_at, processed_at, embedding

memories
  id, session_id, repo_id, workspace_root, type, title, description,
  files_read, files_modified, source_observation_ids, source_trace_ids,
  created_at, embedding

summaries
  id, session_id, repo_id, workspace_root, summary, key_changes,
  key_learnings, created_at
```

The FTS5 mirrors (`observations_fts`, `memories_fts`) are kept in sync by SQL triggers on the base tables — there is no manual sync code. The optional `memories_vec` virtual table is created via `tryCreateVecTable`; if `sqlite-vec` is not installed, the function returns silently and the vector search falls back to an in-memory cosine implementation loaded from BLOBs.

Embeddings are stored as `BLOB` (Float32). JSON columns are stored as `TEXT`.

## Concurrency and crash safety

- A single `termyte synth` process holds an exclusive lock (`src/synth/lock.ts`) so two synth runs cannot fight over the same unprocessed traces.
- The spend file (`src/synth/spend.ts`) uses atomic temp-file rename for concurrent safety within a single process.
- The traces table has a partial index on `processed_at IS NULL`, so "find me the next batch" is a cheap index probe.
- A trace is only marked `processed_at` **after** its observations are written. A crash mid-batch leaves the trace unprocessed and re-processable.
- The MCP server is single-process and synchronous from the agent's perspective. The store opens in WAL mode so the search and ingest paths do not block each other.
