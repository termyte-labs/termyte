# Concepts

The memory layer is structured as a three-stage pipeline. Each stage is a separate table in the local SQLite database, with explicit provenance links so you can always trace a memory back to the raw event that produced it.

## The data model

```
                        ┌──────────┐
   agent hook events →  │  traces  │   immutable, raw
                        └─────┬────┘
                              │ observer / synth (LLM)
                              ▼
                        ┌──────────────┐
                        │ observations │   per-trace, with provenance
                        └─────┬────────┘
                              │ consolidation (LLM)
                              ▼
                        ┌──────────┐
                        │ memories │   embedded, searchable, durable
                        └──────────┘

  +  sessions     one row per agent session
  +  summaries    one markdown summary per session
```

### `traces` — raw, immutable

A `traces` row is the literal shape of a single agent event after platform normalization: tool name, tool input, tool output, the user prompt that triggered it, the assistant's final response (if any), and the list of files that were read or modified. Traces are **never deleted or rewritten**. Every trace has a `processed_at` column; while it's `NULL`, the trace is a candidate for the next synth run.

Trace columns you'll see in `termyte trace <id> --json`:

| Column | Type | Notes |
|---|---|---|
| `id` | int | Primary key. |
| `session_id` | text | Foreign key into `sessions`. |
| `timestamp` | int | `Date.now()`-style ms. |
| `event_type` | text | One of `session_init`, `user_prompt`, `tool_use`, `assistant_message`, `session_end`. |
| `tool_name` | text? | e.g. `Read`, `Bash`, `Edit`. `null` for non-tool events. |
| `tool_input` / `tool_output` | text? | JSON-encoded. `null` for non-tool events. |
| `files_read` / `files_modified` | text? | JSON-encoded string arrays. |
| `user_prompt` | text? | The user message, if applicable. |
| `final_response` | text? | The assistant's final message, if applicable. |
| `processed_at` | int? | `null` until the synth marks it processed. |
| `ingest_status` | text | `ok` or `failed`. |
| `ingest_error` | text? | Human-readable reason on `failed`. |
| `ingest_attempts` | int | Retry counter. |

The `ingest_*` columns are operational state. They let termyte surface errors that were previously silent, and they let a reaper detect traces that an interrupted run half-processed.

### `observations` — per-trace, with provenance

An `observations` row is a small, LLM-extracted fact that came out of a batch of related traces during synthesis. Each observation has:

- A type — `bugfix`, `convention`, `warning`, `procedure`, or `fact`.
- A title and optional description.
- The list of `files_read` / `files_modified` / `commands_executed` that produced it.
- `source_trace_ids` — the explicit link back to the traces that fed it.

Observations are intermediate. They are not directly searched by default; they exist to feed the memory consolidation step and to support reprocessing if the LLM is changed.

### `memories` — embedded, durable, searchable

A `memories` row is the consolidated knowledge termyte surfaces in search results. A memory usually aggregates several observations across one or more sessions. Each memory carries:

- A type — same five types as observations.
- A title and optional description.
- The list of `files_read` / `files_modified` that the memory is about.
- `source_observation_ids` — the observations that fed into it.
- `source_trace_ids` — the transitive provenance back to the raw events.
- `embedding` — a 768-dim (Nomic Embed v1.5) or 384-dim (BGE Small) float vector, stored as a BLOB.

Memories are what `termyte search` and `termyte context` return. They are durable — the corpus accumulates, and a memory that was true two months ago remains true today.

### `sessions` and `summaries`

A `sessions` row groups all traces and observations from a single agent run. It has `started_at`, `ended_at`, `project`, `repo_id`, and `workspace_root` (auto-detected from the working directory).

A `summaries` row is a single markdown paragraph per session, with a list of `key_changes` and `key_learnings`. Summaries are produced lazily on `Stop` events and are useful for high-level "what did we do in that session" recall.

## The pipeline

There are three meaningful entry points:

1. **Capture** runs inside the agent's hook. It normalizes the agent's payload into a `NormalizedEvent` and writes a `traces` row. It is fast (single SQLite insert) and runs in the agent's process.
2. **Synthesis** runs in a separate process (`termyte synth`). It reads unprocessed traces in batches, hands each batch to the configured `AgentAdapter` (Claude Code, Codex, OpenCode, or Gemini CLI), parses the LLM's XML output, and writes `observations` and (in stage 2) `memories` back to SQLite.
3. **Retrieval** runs on demand (`termyte search`, `termyte context`, or the MCP `search_memories` tool). It does hybrid FTS5 + vector search with reciprocal-rank fusion and file-aware boosting.

For the full lifecycle see [Architecture](./architecture.md).

## Memory types

Termyte classifies both observations and memories into one of five types:

| Type | When the LLM uses it | Example |
|---|---|---|
| `bugfix` | A real defect was diagnosed and resolved. | "Session-resume crashes when the SQLite file is missing — fixed by upsert-on-insert and a clearer error." |
| `convention` | A coding, testing, or tooling convention that the codebase follows. | "TypeScript imports use `.js` extensions even for `.ts` sources (NodeNext)." |
| `warning` | A gotcha, footgun, or "don't do this" the agent should remember. | "Don't add an `;` at the end of `.d.ts` files; tsx prints a parse error." |
| `procedure` | A repeatable, multi-step recipe. | "To bump the schema: add a migration, write a test, update `runMigrations`, and run `npm test`." |
| `fact` | A general statement that doesn't fit the other types. | "The MCP server's stdio transport is JSON-RPC 2.0." |

A memory's type shows up in search results and is filterable via `termyte memories --type warning`.

## What does and doesn't get stored

- ✅ Tool calls, file reads/writes, shell commands, user prompts, assistant final responses.
- ✅ File paths touched (`files_read` / `files_modified`).
- ❌ Tool input/output is JSON-encoded into the `traces` table for debuggability, but it is **not** part of the searchable text. The synthesis LLM sees it, the embeddings model does not, and it is not returned by `termyte search`.
- ❌ Agent-specific metadata that doesn't fit `NormalizedEvent` is dropped at the adapter boundary.

If you need to inspect a raw trace (for example, to debug a malformed payload), use `termyte trace <id> --json`.
