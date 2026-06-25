# AGENTS.md

## Project overview

Termyte is a memory layer for coding agents — a TypeScript ESM CLI that captures agent tool executions, enriches them via LLM into structured memories, and serves them through hybrid (FTS5 + vector) search. It is a port of `claude-mem`'s core architecture, stripped to MVP essentials.

- **Language**: TypeScript 5.8, strict mode, ESM (NodeNext moduleResolution)
- **Runtime**: Node >= 20
- **Database**: SQLite via `better-sqlite3` (WAL mode, foreign keys ON)
- **Testing**: Vitest (forks pool, single fork, 30s timeout)
- **Optional native dep**: `sqlite-vec` for vector virtual tables (loaded via `tryCreateVecTable`, fails silently if unavailable)
- **Optional local ML**: `@xenova/transformers` for offline embeddings (dynamic import, not loaded at module init)

## Essential commands

```bash
npm install              # install deps (better-sqlite3 is native, needs node-gyp on some platforms)
npm run build            # TypeScript compilation (tsc -p tsconfig.json → dist/)
npm run typecheck        # type-check only, no emit (tsc --noEmit)
npm test                 # full test suite (vitest run)
npm run test:watch       # watch mode
```

No deploy, lint, or format commands are configured.

## Architecture and data flow

```
Agent hook payload (stdin JSON)
  → PlatformAdapter.normalize() → NormalizedEvent
  → HookRunner (upserts session, calls Ingestor)
  → Ingestor.ingest() → Store.insertTrace()       [traces table]

Observer (driven by termyte-hook inline, or termyte-worker standalone):
  Stage 1: processTraceToObservation()
    → LLM.chat(trace → XML) → parseAgentXml()
    → Store.insertObservation()                   [observations table]
    → fire-and-forget embedding compute
  Stage 2: consolidateObservations()
    → LLM.chat(observations → XML) → parseAgentXml()
    → Store.insertMemory() + embedding compute     [memories table]
  generateSummary()
    → LLM.chat(session context → XML) → Store.upsertSummary()

Retrieval:
  HybridSearch = FTS5 (keyword) + VectorSearch (cosine similarity)
    → Reciprocal Rank Fusion (k=60) → ranked results
  ContextBuilder → renders markdown for agent prompts
```

**Five SQLite tables** (schema defined in `src/storage/migrations.ts`):
- `sessions` — one row per agent session
- `traces` — immutable raw events (JSON columns as TEXT, `processed_at` is operational state for crash-safety)
- `observations` — extracted by Stage 1 LLM
- `memories` — consolidated by Stage 2 LLM; embedding stored as BLOB
- `summaries` — one per session, upserted

FTS5 virtual tables (`observations_fts`, `memories_fts`) are kept in sync via SQL triggers on INSERT/UPDATE/DELETE — no manual sync needed.

## Module organization

```
src/
  index.ts              — Public API + createTermyte() convenience function
  core/types.ts         — All shared types (Trace, Observation, Memory, Summary, Session)
  capture/              — Platform adapters + Ingestor + file extraction
    adapter.ts          — NormalizedEvent + PlatformAdapter interface
    claude-code.ts      — Claude Code adapter
    codex.ts            — Codex adapter
    opencode.ts         — OpenCode adapter
    cursor.ts           — Cursor adapter
    files.ts            — Shared file-path extraction from tool input/output
    ingest.ts           — Ingestor: NormalizedEvent → Trace
    util.ts             — Shared helpers (isObject, pickString)
  storage/              — SQLite wrapper
    connection.ts       — openDatabase/closeDatabase + pragmas
    migrations.ts       — Schema DDL (CREATE TABLE, FTS5, triggers, vec0)
    store.ts            — Full CRUD for all 5 tables
  observer/             — LLM-based observation extraction
    provider.ts         — LLMProvider interface + ChatMessage/ChatOptions types
    openai-provider.ts  — OpenAI-compatible HTTP chat completion
    prompts.ts          — System/user prompts for observation/consolidation/summary
    parser.ts           — XML parser for LLM output (<observation>, <summary>, <skip_summary />)
    pipeline.ts         — Observer class: 2-stage pipeline + queue + flush
  retrieval/            — Memory search
    embeddings.ts       — EmbeddingsProvider interface + OpenAI + NoOp
    local-embeddings.ts — Transformers.js-based local embeddings (Nomic/BGE)
    fts.ts              — FTS5 keyword search
    vector.ts           — In-memory cosine similarity (file-aware boosting)
    hybrid.ts           — RRF fusion of FTS + vector
  hooks/                — Hook protocol
    runner.ts           — HookRunner: stdin → adapter → ingest → observe
  context/              — Prompt rendering for agents
    builder.ts          — ContextBuilder + renderContext/renderHybridResults
  cli/                  — CLI entry points
    index.ts            — Main CLI (termyte search|context|memories|trace|session|sessions)
    hook.ts             — termyte-hook <platform> (reads stdin, ingests, flushes)
    worker.ts           — termyte-worker [--once] (batch processes unprocessed traces)
    config.ts           — loadConfig() from env vars
    search.ts           — search subcommand
    context.ts          — context subcommand
```

## Key patterns and conventions

### Import extensions
All imports use `.js` extensions despite source being `.ts` — this is required by NodeNext moduleResolution:
```ts
import { Store } from "../storage/store.js";
```

### SQLite JSON serialization
- JSON columns (files_read, files_modified, source_trace_ids, etc.) are stored as TEXT via `JSON.stringify()`.
- Reads use `parseJSON()` / `parseNumberArray()` with fallback to empty values on parse errors.
- Embeddings are `Float32Array` → `Buffer` for BLOB storage, and reversed on read.

### Crash safety via `processed_at`
The `traces.processed_at` column is set after the observer processes a trace. If the process dies mid-batch, the trace remains `NULL` and is picked up by the next `processUnprocessedOnce()` call. Same pattern applies to `observations.processed_at`.

### Observer queue
The Observer maintains an in-memory queue with `setImmediate`-based scheduling. `enqueue(trace)` adds to queue; `flush()` awaits all pending work. The hook driver calls `flush()` before exit to ensure traces are processed atomically with memory writes.

### MockLLM
Tests use `MockLLM` from `test/mock-llm.js`. Call `setResponse(xml)` or `setResponses([...])` to queue canned replies. Throws if called with no response queued.

### FixedEmbeddings
Retrieval tests and integration tests define a local `FixedEmbeddings` class (FNV-hash-based, normalized) rather than using live APIs or Transformers.js. This ensures deterministic, network-free tests.

### NoOpEmbeddingsProvider
When no embedding API key is configured, `NoOpEmbeddingsProvider` is used — `embed()`/`embedBatch()` throw, and `HybridSearch.search()` catches the error and degrades to FTS-only.

## Testing patterns

- **In-memory SQLite**: All tests open `":memory:"` databases in `beforeEach` and close via `store.close()`.
- **Test file structure**: Each test file is self-contained — setups its own DB, seeds data, asserts, cleans up.
- **Vitest globals**: `describe`, `it`, `expect`, `beforeEach` are imported explicitly (no global leakage).
- **Pool config**: `pool: "forks"` with `singleFork: true` because `better-sqlite3` is a native module that doesn't play well with Vitest's default worker threads.
- **Timeout**: 30 seconds via `testTimeout: 30_000`.

## Important gotchas

1. **`pool: "forks"` + `singleFork: true` is required** — changing this will cause native module errors with better-sqlite3.
2. **The `.js` extension in imports is mandatory** — TypeScript won't emit correct output without it under NodeNext.
3. **`@xenova/transformers` is dynamically imported** in `src/retrieval/local-embeddings.ts` — so tests don't pay the ONNX runtime cost.
4. **`sqlite-vec` is optional** — `tryCreateVecTable` catches failures silently. Vector search falls back to in-memory cosine similarity loaded from BLOBs.
5. **Embedding persistence is fire-and-forget** — embeddings are computed asynchronously after memory/observation insert and errors are swallowed. The memory may be searchable before its embedding is stored.
6. **LLM output is XML parsed by regex** — not a real XML parser. Code fences (` ```xml ... ``` `) are stripped before parsing. Unknown observation types default to `"fact"`.
7. **`ConsolidationBatchSize` defaults differ** — Stage 1 `batchSize` defaults to 5, Stage 2 `consolidationBatchSize` defaults to 10. These control `processUnprocessedOnce()` batching, not the inline hook path.
8. **The `BaseUrl` must not end with `/`** — `OpenAICompatibleProvider.chat()` strips trailing slashes before appending `/chat/completions`, but it's safer to configure without them.

## Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `TERMYTE_DB` | `./termyte.db` | `:memory:` for tests |
| `TERMYTE_LLM_BASE_URL` | `https://api.openai.com/v1` | Also reads `OPENAI_BASE_URL` |
| `TERMYTE_LLM_API_KEY` | (none) | Also reads `OPENAI_API_KEY` |
| `TERMYTE_LLM_MODEL` | `gpt-4o-mini` | |
| `TERMYTE_EMBED_BASE_URL` | same as LLM | Also reads `OPENAI_BASE_URL` |
| `TERMYTE_EMBED_API_KEY` | falls back to `OPENAI_API_KEY` | |
| `TERMYTE_EMBED_MODEL` | `text-embedding-3-small` | |
| `TERMYTE_EMBED_DIMENSIONS` | `1536` | |

If no embedding API key is set, semantic search is disabled (FTS-only).
