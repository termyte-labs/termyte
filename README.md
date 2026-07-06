# Termyte

Termyte is a local-first memory layer for coding agents. It captures agent execution as traces, derives structured observations and memories, and retrieves prior knowledge through keyword and semantic search.

The current repository contains a real durable memory pipeline, but it is not yet a self-correcting system. Feedback and lifecycle primitives exist; the closed loop that attributes outcomes to injected memories and automatically corrects future retrieval is still under construction. See [PLAN.md](PLAN.md).

## Quick Start

1. Install Termyte and wire one supported agent with `termyte install <platform>`.
2. Run `termyte smoke` to confirm hooks, queue health, and write a portable `.termyte/share/context.md` file. Add `--json` if you want a scriptable result. Add `--prompt "..."` and `--adapter <id>` to exercise a live agent adapter when one is installed. For example: `termyte smoke --adapter codex --prompt "Reply with exactly: hello" --json`.
3. Use `termyte doctor` if you want a narrower install check. It also accepts `--json`.

The first useful loop should be: capture a session, export the shared context, then reuse that context in a second agent.

## Current status

Implemented:

- adapters for Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Windsurf, and raw payloads;
- immutable trace capture in SQLite;
- durable jobs with leases, retries, backoff, and dead-letter state;
- LLM extraction from traces to observations and consolidation from observations to memories;
- trace-to-observation-to-memory provenance;
- local embeddings through Transformers.js;
- memory FTS5 and sqlite-vec cosine retrieval fused with reciprocal-rank fusion, with an in-memory cosine fallback;
- typed FTS retrieval for traces, observations, memories, summaries, and episodes through the document corpus;
- MCP tools, hook handlers, local diagnostics, lifecycle fields, and explicit feedback persistence;
- attributable context injections with ordered retrieval scores and rendered items;
- a zero-paid retrieval benchmark runner with leakage checks and reproducible artifacts;
- deterministic unit and integration tests.

Incomplete:

- installed hooks automatically start a detached `termyte-worker` to drain the durable queue, but only one worker runs per database and processing requires `TERMYTE_LLM_API_KEY`;
- automatic outcome attribution is not implemented;
- correction text is not yet verified against repository evidence;
- confidence, importance, decay, usage, and explicit feedback affect ranking through a bounded multiplier; calibration on public corpora remains incomplete;
- sqlite-vec retrieval uses bounded candidate overfetch before lifecycle/repository filtering; filtered corpora still need scale validation;
- public benchmark dataset loaders, competitor adapters, and the pipeline benchmark track are not implemented;

Do not describe the current version as self-correcting. The target loop is:

```text
capture execution
  -> derive grounded observations
  -> consolidate candidate memories
  -> verify and deduplicate
  -> retrieve eligible memories
  -> record the exact injected set
  -> observe downstream actions and outcomes
  -> attribute help or harm
  -> reinforce, correct, conflict, or supersede
  -> change future retrieval
```

## Architecture

```text
Agent hook payload
  -> PlatformAdapter.normalize()
  -> HookRunner
  -> Ingestor
  -> traces
  -> durable extract_observation job
  -> observations
  -> durable embed_observation job
  -> durable consolidate_memory job
  -> memories
  -> durable embed_memory job
  -> FTS5 + vector retrieval
  -> ContextBuilder / MCP / hook context
```

`termyte-hook` captures and enqueues, then asks the `WorkerSupervisor` to start a detached `termyte-worker` that drains the durable pipeline without blocking the agent. A single-instance lockfile ensures only one worker drains a given database. `termyte synth` is an alternative agent-driven observation path that also queues downstream processing.

## Storage

The schema is defined in `src/storage/migrations.ts` and includes:

- `sessions`: agent session identity and repository scope;
- `traces`: immutable raw events and pipeline state;
- `jobs`: durable work, leases, retry state, and dead letters;
- `observations`: structured trace-derived evidence;
- `memories`: consolidated knowledge, embeddings, confidence, importance, and lifecycle state;
- `summaries`: session summaries;
- `memory_edges`: relationship schema for support, contradiction, supersession, and duplication;
- `memory_feedback`: explicit shown/used/ignored/downranked/corrected events;
- `context_injections` and `context_injection_items`: attributed retrieval sets and ordered score evidence;
- `documents`: typed searchable corpus;
- `document_embeddings`: metadata for sqlite-vec document embeddings.

FTS5 virtual tables and triggers maintain observation, memory, and document keyword indexes.

## Development setup

Requirements:

- Node.js 20 or newer;
- a working native build for `better-sqlite3`;
- an OpenAI-compatible chat-completion endpoint for observation and memory generation;
- network access on first use if the local embedding model is not cached.

```bash
npm install
npm run typecheck
npm test
npm run build
```

The built CLI lives under `dist/cli/`. Invoke built commands directly:

```bash
node dist/cli/index.js help
node dist/cli/index.js eval --suite all --json
node dist/cli/worker.js --until-idle --json
```

## CLI surface

```text
termyte search <query> [--repo r] [--limit n] [--json]
                       [--files f1,f2]
                       [--type trace|observation|memory|summary|episode|all]
termyte context [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t] [--json]
termyte memories [--repo r] [--limit n] [--type t]
termyte memory <id> [--json]
termyte trace <id> [--json]
termyte session <id> [--json]
termyte sessions [--limit n]
termyte start [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t] [--path path] [--json]
termyte smoke [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t] [--path path] [--adapter id] [--prompt text] [--json]
termyte share [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t] [--path path]
termyte doctor [--json]
termyte install <platform> [--target user|project]
termyte eval [--suite retrieval|durability|lifecycle|all] [--json]
termyte bench run [--dataset <path>] [--suite custom|longmemeval|scale]
                  [--size n] [--track retrieval]
                  [--adapter grep,fts,termyte] [--output directory] [--seed n]
termyte viewer [--host 127.0.0.1] [--port 7331]
termyte synth [options]
termyte stats
termyte mcp
```

Supported installer targets are defined by `src/integrations/installers/index.ts`. Installation configures capture and context hooks; each hook automatically starts a detached `termyte-worker` to process captured traces into memories (set `TERMYTE_AUTO_WORKER=0` to disable).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | SQLite database path |
| `TERMYTE_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat endpoint |
| `TERMYTE_LLM_API_KEY` | falls back to `OPENAI_API_KEY` | Chat endpoint credential |
| `TERMYTE_LLM_MODEL` | `gpt-4o-mini` | Observation and consolidation model |
| `TERMYTE_EMBED_MODEL_LOCAL` | `nomic-embed` | `nomic-embed` or `bge-small` local embedding model |
| `TERMYTE_HOOK_PATH` | auto-detected | Override built hook entry path |
| `TERMYTE_WORKER_PATH` | auto-detected | Override built worker entry path |
| `TERMYTE_AUTO_WORKER` | `1` | When not `0`/`false`, the hook starts a detached worker after each ingest |

Local embeddings run through `@xenova/transformers`. They do not use the hosted embedding configuration described by older versions of this README.

## Retrieval behavior

Memory retrieval uses:

1. FTS5 over `memories_fts`;
2. local query embeddings;
3. cosine search through a dimension-specific sqlite-vec index, with persisted memory-BLOB scanning when the native extension is unavailable;
4. reciprocal-rank fusion with `k = 60`;
5. optional file-overlap boosting in the vector branch.

When embeddings fail, hybrid search degrades to FTS-only. Non-memory typed retrieval uses `documents_fts` and does not initialize embeddings.

Default memory retrieval enforces lifecycle eligibility: only `active` memories are returned by FTS, vector, recent-memory context, MCP, and the CLI. Stale, conflicted, superseded, deleted, and failed memories are excluded by default; pass `--all-states` to `termyte search` / `termyte memories` for a diagnostic override. Eligible candidates are fused with RRF and then adjusted by a bounded 0.75–1.25 multiplier using confidence, importance, decay, bounded usage, and explicit feedback. Automatic `shown` events are attribution-only and do not reinforce ranking. JSON search and persisted injection items expose the score breakdown. Treat retrieved memories as unverified context while calibration remains incomplete.

## Testing and evidence

```bash
npm run typecheck
npm test
npm run build
node dist/cli/index.js eval --suite all --json
```

The test suite is deterministic and network-free. It uses in-memory SQLite, canned LLM XML, and fixed embeddings. Passing tests prove component behavior, not live agent compatibility or improved agent outcomes.

The current retrieval evaluation is a regression harness, not credible public benchmark evidence. `EVAL-001` and later tasks in `PLAN.md` replace it with independently labeled corpora and controlled agent trials.

`termyte bench run` accepts an immutable JSON corpus containing `documents` and independently judged `queries`, the official LongMemEval-S shape, or a deterministic synthetic scale corpus. It writes `manifest.json`, per-query and failure NDJSON, aggregate metrics, resource usage, and `report.md`. `grep` is the lexical control, `fts` exercises Termyte FTS, and `termyte` runs the actual local FTS + embedding + vector-scan + RRF path using BGE Small by default. The model may download on first use. Pipeline evaluation, LoCoMo/MemoryAgentBench loaders, sqlite-vec retrieval, and external competitor adapters remain planned.

## Security and data handling

Termyte stores agent prompts, tool inputs, tool outputs, file paths, and final responses locally. A complete redaction layer is not yet implemented. Do not use the current version on sensitive repositories or secrets without reviewing captured payloads and database access.

The local diagnostics viewer binds to `127.0.0.1` by default and has no authentication.

## Repository operating model

Engineering work is routed through five founding-engineer skills under `.agents/skills`. Their ownership model and completion protocol are documented in [AGENTS.md](AGENTS.md). The prioritized implementation backlog is [PLAN.md](PLAN.md).
