# Termyte

Termyte is a local-first memory layer for coding agents. It captures agent execution as traces, derives structured observations and memories, and retrieves prior knowledge through keyword and semantic search.

The current repository contains a real durable memory pipeline, but it is not yet a self-correcting system. Feedback and lifecycle primitives exist; the closed loop that attributes outcomes to injected memories and automatically corrects future retrieval is still under construction. See [PLAN.md](PLAN.md).

## Current status

Implemented:

- adapters for Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Windsurf, and raw payloads;
- immutable trace capture in SQLite;
- durable jobs with leases, retries, backoff, and dead-letter state;
- LLM extraction from traces to observations and consolidation from observations to memories;
- trace-to-observation-to-memory provenance;
- local embeddings through Transformers.js;
- memory FTS5 and in-memory cosine retrieval fused with reciprocal-rank fusion;
- typed FTS retrieval for traces, observations, memories, summaries, and episodes through the document corpus;
- MCP tools, hook handlers, local diagnostics, lifecycle fields, and explicit feedback persistence;
- deterministic unit and integration tests.

Incomplete or currently broken:

- installed hooks enqueue work but do not automatically run the durable worker;
- deduplication and summary jobs are declared but currently execute as no-ops;
- decay and deduplication algorithms are not connected to production workers;
- stale, conflicted, superseded, and deleted memories are not excluded from default memory retrieval;
- context injection IDs and automatic outcome attribution are not implemented;
- the sqlite-vec document index exists but is not used by the active retrieval path;
- retrieval evaluation currently leaks expected query terms into candidate documents and is not product-quality evidence;
- npm entry points target `dist/cli/*`, while the current compiler emits `dist/src/cli/*`.

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

Hooks only capture and enqueue. `termyte-worker` executes the durable pipeline. `termyte synth` is an alternative agent-driven observation path that also queues downstream processing.

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

The current build emits CLI files under `dist/src/cli/`. Until packaging task `PKG-001` in `PLAN.md` is completed, invoke the built checkout directly:

```bash
node dist/src/cli/index.js help
node dist/src/cli/index.js eval --suite all --json
node dist/src/cli/worker.js --until-idle --json
```

## CLI surface

```text
termyte search <query> [--repo r] [--limit n] [--json]
                       [--files f1,f2]
                       [--type trace|observation|memory|summary|episode|all]
termyte context [--repo r] [--query q] [--limit n] [--files f1,f2] [--type t]
termyte memories [--repo r] [--limit n] [--type t]
termyte memory <id> [--json]
termyte trace <id> [--json]
termyte session <id> [--json]
termyte sessions [--limit n]
termyte install <platform> [--target user|project]
termyte eval [--suite retrieval|durability|lifecycle|all] [--json]
termyte viewer [--host 127.0.0.1] [--port 7331]
termyte synth [options]
termyte stats
termyte mcp
```

Supported installer targets are defined by `src/integrations/installers/index.ts`. Installation currently configures capture and context hooks; it does not supervise `termyte-worker`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | SQLite database path |
| `TERMYTE_LLM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible chat endpoint |
| `TERMYTE_LLM_API_KEY` | falls back to `OPENAI_API_KEY` | Chat endpoint credential |
| `TERMYTE_LLM_MODEL` | `gpt-4o-mini` | Observation and consolidation model |
| `TERMYTE_EMBED_MODEL_LOCAL` | `nomic-embed` | `nomic-embed` or `bge-small` local embedding model |
| `TERMYTE_HOOK_PATH` | auto-detected | Override built hook entry path |

Local embeddings run through `@xenova/transformers`. They do not use the hosted embedding configuration described by older versions of this README.

## Retrieval behavior

Memory retrieval uses:

1. FTS5 over `memories_fts`;
2. local query embeddings;
3. cosine similarity over persisted memory BLOBs;
4. reciprocal-rank fusion with `k = 60`;
5. optional file-overlap boosting in the vector branch.

When embeddings fail, hybrid search degrades to FTS-only. Non-memory typed retrieval uses `documents_fts` and does not initialize embeddings.

Current ranking does not yet apply lifecycle-state filtering, confidence, importance, decay, or feedback. Treat retrieved memories as unverified context.

## Testing and evidence

```bash
npm run typecheck
npm test
npm run build
node dist/src/cli/index.js eval --suite all --json
```

The test suite is deterministic and network-free. It uses in-memory SQLite, canned LLM XML, and fixed embeddings. Passing tests prove component behavior, not live agent compatibility or improved agent outcomes.

The current retrieval evaluation is a regression harness, not credible public benchmark evidence. `EVAL-001` and later tasks in `PLAN.md` replace it with independently labeled corpora and controlled agent trials.

## Security and data handling

Termyte stores agent prompts, tool inputs, tool outputs, file paths, and final responses locally. A complete redaction layer is not yet implemented. Do not use the current version on sensitive repositories or secrets without reviewing captured payloads and database access.

The local diagnostics viewer binds to `127.0.0.1` by default and has no authentication.

## Repository operating model

Engineering work is routed through five founding-engineer skills under `.agents/skills`. Their ownership model and completion protocol are documented in [AGENTS.md](AGENTS.md). The prioritized implementation backlog is [PLAN.md](PLAN.md).
