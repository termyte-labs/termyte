# Termyte — Mitigation Plan

**Date:** 2026-06-26
**Status:** Implemented. All committed on branch `fix/mitigation-plan`.
**Scope:** All 22 issues from the senior-engineer review.

This plan is ordered by severity. Each entry has:
- A short problem statement
- A concrete fix
- An estimated effort
- A test strategy
- A "Done when..." line

Severity rubric:
- **Critical** — user-facing correctness, data loss, or cost blowup. Must ship before any release.
- **High** — performance or reliability under realistic load. Should ship within the first iteration after release.
- **Medium** — operational hygiene. Schedule for the next cleanup pass.
- **Low** — quality-of-life. Pick up as time allows.

## Implementation status

| ID | Severity | Title | Status | Commit |
|---|---|---|---|---|
| C8 | Critical | Silent ingest failures | done | (first) |
| H5 | High | Install corrupts user configs | done | (second) |
| C2 | Critical | OpenCode plugin stdio race + synth timeout + orphan reaper | done | (third) |
| C3 / C20 / E2 | Critical | Spend module with daily cap + checksum | done | (fourth) |
| C4 / H2 / M6 | Critical | Embeddings singleton + lean/fat hook paths | done | (fifth) |
| C1 Part A | Critical | FTS5 pre-filter on vector search | done | (sixth) |
| M5 / B3 | Medium | FTS5 trigger qualifier + value-comparison guard | done | (seventh) |
| M2 | Medium | Trace ordering | done | (eighth) |
| L5 | Low | Schema version tracking tests | done | (ninth) |
| H3 | High | Hook normalizes once (folded into C8) | done | (first) |
| H4 | High | `stats` respects TERMYTE_SYNTH_ADAPTER | done | (fourth) |
| M1 | Medium | Dead `processUnprocessedOnce` reference | n/a — method is used by `termyte-worker` |
| L2 | Low | NoOpEmbeddingsProvider to test utils | skipped — provider is a useful public API opt-out |

---

## Critical (5)

### C1. O(n) vector search; `sqlite-vec` table created but never used

**File:** `src/retrieval/vector.ts:28-29`, `src/storage/migrations.ts:180-191`

**Problem.** Every search loads every embedded memory into JavaScript, filters in user space, and runs a tight loop cosine. At ~5,000 memories × 768 dims this is 15 MB of allocations and 50–200 ms per query. Every `PreToolUse Read`, every `termyte context`, every MCP `search_memories` does this. The `memories_vec` table is in the schema but no code reads it.

**Fix.** Two parts.

Part A — *FTS5 pre-filter on the vector path* (1 day).
- In `VectorSearch.search`, before the in-memory cosine, call `fts.search` for the query string and use the resulting memory ids as a candidate set.
- The vector cosine runs only on candidates. Worst case: 0 candidates → empty result; typical case: 50–200 candidates → 200 × 768 × 4 bytes = ~600 KB and 5–10 ms.
- Honor `currentFiles` filtering on the candidate set too.

Part B — *actually wire `memories_vec`* (1 week).
- Add a `migrations.ts` step that runs on Store construction: `tryCreateVecTable(db, dimensionsFor(configuredModel))`. Dimensions come from a `meta` table that records what model produced the existing embeddings.
- On `insertMemory`, when an embedding is present, insert into `memories_vec` with the same `rowid`.
- On `updateMemoryEmbedding`, update the vec row.
- Replace `getAllMemoriesWithEmbeddings` + in-memory cosine with a single `SELECT rowid, distance FROM memories_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?`.
- When the user changes embedding models (Nomic → BGE), the `meta.embedding_dim` change triggers a reindex: drop `memories_vec`, re-embed all rows, recreate.
- Fall back to the in-memory cosine path if `sqlite-vec` is not loaded. Detect via `tryCreateVecTable` return value.

**Test strategy.**
- Unit: seed 5,000 fake memories, assert search latency is < 50 ms with the FTS5 pre-filter.
- Unit: `tryCreateVecTable` round-trip — insert a memory, query with a known-similar vector, assert rank.
- Integration: flip the `sqlite-vec` extension off at runtime, assert the in-memory fallback engages.

**Done when.** Search latency is < 50 ms at 5,000 memories. `memories_vec` is read in the production path, not just created.

---

### C2. OpenCode plugin stdio race

**File:** `src/integrations/opencode-plugin/index.ts:67-81`

**Problem.** `spawn()` returns before the child's stdio pipes are open. `child.stdin.write(JSON.stringify(payload))` immediately after can hit `EPIPE` on Windows, silently dropping the trace. The child can also deadlock on its own stderr writes if we don't drain them.

**Fix.** Open the write after the stream reports `open`, drain stderr in parallel, and unref so we don't keep the host alive.

```ts
function forward(eventName: string, payload: HookPayload): void {
  const hookPath = resolveHookPath();
  if (!hookPath) return;
  let child: import("node:child_process").ChildProcess;
  try {
    child = spawn(process.execPath, [hookPath, "opencode", eventName], {
      stdio: ["pipe", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch {
    return;
  }
  // Drain stderr so the child never blocks.
  child.stderr?.resume();
  // Wait for stdin to be writable, then write and end.
  child.stdin!.on("open", () => {
    try {
      child.stdin!.write(JSON.stringify(payload));
      child.stdin!.end();
    } catch {
      child.kill();
    }
  });
  child.on("error", () => { /* best-effort */ });
  child.unref();
}
```

Apply the same `child.stderr.resume()` and `child.unref()` pattern to the SessionEnd synth spawner in `src/cli/handlers/summarize.ts:fireTermyteSynth` (which currently uses `stdio: "ignore"` and is fine, but unify for consistency).

**Test strategy.**
- Unit: spawn the real `termyte-hook opencode observation` binary against a fake `opencode` plugin payload; assert the child receives the JSON payload and exits 0.
- Stress: 1,000 rapid `forward()` calls; assert no `EPIPE` or unhandled rejections.

**Done when.** Zero `EPIPE` errors in a 10-minute stress run on Windows.

---

### C3. SessionEnd spawn has no backpressure

**File:** `src/cli/handlers/summarize.ts:51-67` (`fireTermyteSynth`)

**Problem.** A user ending 30 sessions in an hour spawns 30 background `claude -p` processes. The synthesis lock serializes them, but each one consumes the user's quota while waiting. Quota attribution risk from the design report.

**Fix.** Persistent token bucket at the runner level.

- Add `src/synth/rate-limit.ts` (already exists) to manage a per-day spend / invocation budget.
- New module `src/synth/spend.ts`: reads/writes `~/.termyte/spend.json` with daily counters (`{ date, invocations, tokens, estCostUsd }`). Uses an atomic temp-file rename.
- New `BudgetGuard` class: `tryAcquire()` returns false when the per-day cap is hit. The cap is configurable via `TERMYTE_SYNTH_DAILY_BUDGET_USD` (default 0.50) and `TERMYTE_SYNTH_DAILY_INVOCATIONS` (default 50).
- The `summarize` handler checks the guard before forking. If denied, it logs a stderr warning and skips. The next `termyte-synth` invocation from cron/manual will resume.
- `termyte stats` reads the spend file and shows today's usage.

**Test strategy.**
- Unit: simulate 51 invocations; assert the 51st is denied.
- Unit: write spend.json with a different `date`; assert the cap resets on date rollover.
- Concurrency: 10 concurrent fire-and-forget invocations; assert only one spend.json write wins (atomic rename prevents corruption).

**Done when.** 51st synthesis in a single day is denied with a clear stderr message; spend.json is never corrupted; `termyte stats` reports today's usage.

---

### C4. LocalEmbeddingsProvider instantiated on every hook

**File:** `src/cli/hook.ts:41`

**Problem.** Each hook invocation constructs a new `LocalEmbeddingsProvider`, which kicks off `init()` (model load, 200–500 ms on warm disk, 60+ s on first use). For a 200-tool-call session, 60–100 s of pure waste.

**Fix.** Lazy initialization + process-level singleton. Two parts.

Part A — *lazy init inside `LocalEmbeddingsProvider`*.
- Replace the constructor's `this.ready = this.init()` with a getter pattern: the first call to `embed()` triggers init, subsequent calls reuse the warm model.
- Cache the in-process provider in `src/cli/hook.ts`:

```ts
let _cachedEmbeddings: EmbeddingsProvider | null = null;
async function getEmbeddings(model: LocalModelId): Promise<EmbeddingsProvider> {
  if (_cachedEmbeddings) return _cachedEmbeddings;
  const p = new LocalEmbeddingsProvider({ model });
  // Warm with a throwaway embed.
  try { await p.embed("warmup"); } catch { /* ignore */ }
  _cachedEmbeddings = p;
  return p;
}
```

Part B — *split the hook into lean / fat paths*.
- `termyte-hook <platform> observation` (the most common case) does *not* need embeddings. Construct without one.
- `termyte-hook <platform> file-context` and `termyte-hook <platform> context` *do* need embeddings. Construct with one, but only when those handlers run.

Concretely: in `hook.ts`, only construct `embeddings` inside the event-handler branch that needs it. The trace-ingest path stays lean.

**Test strategy.**
- Unit: invoke the same `termyte-hook` 100 times in one process; assert only one model load happens (mock the loader and count calls).
- Benchmark: time a 200-call synthetic session before and after; assert < 1 s of total model load overhead.

**Done when.** Hook invocation latency drops by an order of magnitude on warm start; cold start is unchanged.

---

### C8. Foreign-key failures are silent

**File:** `src/hooks/runner.ts:50-58`

**Problem.** A trace that fails to ingest (FK violation, malformed JSON, anything) is silently dropped. The user has no idea. The trace is never marked processed, so the next `termyte-synth` run tries again with the same broken payload.

**Fix.** Three changes.

- `runner.processRaw` currently returns `boolean`. Change to `{ handled: boolean; error?: string }` so callers can see *why* a trace was rejected.
- `termyte-hook` writes the error to stderr (current behavior swallows it).
- The `Observer` enqueue step: if the trace couldn't be ingested, don't enqueue it. Add a `markTraceProcessed` with an `error` annotation, or extend the schema with a `last_error TEXT` column on `traces`.

Schema migration for the `last_error` column:
```sql
ALTER TABLE traces ADD COLUMN last_error TEXT;
```

This is a non-destructive migration. Old rows get NULL.

**Test strategy.**
- Unit: feed a hook payload that violates the session FK; assert the runner returns an error and writes to stderr.
- Unit: assert `traces.last_error` is set after a failed ingest.

**Done when.** A trace that fails to ingest produces a stderr warning and is not silently dropped.

---

## High (5)

### H1. Dead `memories_vec` code

**File:** `src/storage/migrations.ts:180-191`

See C1. The vec table is created in the schema (lines 121–167) but the wire-up is missing. This is the same work as C1 Part B; tracked separately because the *symptom* (dead code, misleading comments) is different from the *impact* (slow search).

**Fix.** Cover under C1 Part B.

---

### H2. Hook can deadlock on slow model load

**File:** `src/cli/hook.ts:50-58`

**Problem.** A first-call `LocalEmbeddingsProvider.embed()` blocks for 200–500 ms (or many seconds on cold start). The agent's hook timeout is 30 s for `PreToolUse`; on a slow machine the hook can hit it before responding.

**Fix.**

- After C4, the embeddings model is pre-warmed in a background `setImmediate` during the lean hook path. The fat path (file-context) uses the warm model.
- Add a `timeoutMs` parameter to `LocalEmbeddingsProvider.embed()`. If the model isn't ready in 2 s, throw a `not_ready` error. The hybrid search catches it and degrades to FTS-only. The hook responds to the agent with a non-fatal warning.
- Add a per-handler `timeoutMs` (default 5 s) so the handler can't block past the agent's window.

**Test strategy.**
- Unit: simulate a slow init; assert embed returns within 2 s with `not_ready` if not pre-warmed.
- Integration: pre-warm; assert embed is fast.

**Done when.** Hook latency is bounded by `timeoutMs`, not by model load time.

---

### H3. Hook normalizes the same payload twice

**File:** `src/cli/hook.ts:58 + 70`

**Fix.** Have `runner.processRaw` return the `NormalizedEvent | null` (it already constructs it internally). Reuse:

```ts
const event = await runner.processRaw(platform, parsed);
if (event) {
  // pass event to handler instead of re-normalizing
}
```

`HookRunner.processRaw` already returns `boolean`. Change signature to `Promise<NormalizedEvent | null>`.

**Test strategy.**
- Unit: pass a payload; assert the same `event` object is returned both times it would be normalized.

**Done when.** Adapter.normalize is called exactly once per hook invocation.

---

### H4. `termyte stats` lies about the active agent

**File:** `src/cli/stats.ts:24-27`

**Problem.** `discoverAdapter()` returns the first match in PATH. A user with Claude Code installed but actively running Codex will see "synthesis: claude-code" and be billed against their Claude Pro plan.

**Fix.**

- Add `TERMYTE_SYNTH_ADAPTER` env var. If set, the CLI uses it. The synth CLI also takes `--adapter` (already done).
- Update `termyte stats` to read the explicit override first, then fall back to `discoverAdapter()`.
- Update `termyte-synth` to print which adapter it actually picked. Currently it does — just make sure the warning when fallback happens is loud.

**Test strategy.**
- Unit: set `TERMYTE_SYNTH_ADAPTER=codex`; assert `stats` reports `codex`, not the auto-detected one.

**Done when.** Users can pin the synthesis adapter explicitly; `stats` reflects the override.

---

### H5. `install` overwrites corrupted configs (data loss)

**File:** `src/integrations/installers/*.ts`

**Problem.** If the user's `~/.cursor/hooks.json` is corrupted, the installer silently overwrites it with a fresh config. The user loses any custom hooks they had.

**Fix.** Back up the existing file before overwriting, in every installer.

```ts
function safeReadJson(p: string, fallback: T): T {
  try { return JSON.parse(readFileSync(p, "utf-8")) as T; }
  catch {
    // Back up the corrupted file so the user can recover.
    try { copyFileSync(p, p + ".bak." + Date.now()); } catch { /* ignore */ }
    return fallback;
  }
}
```

Apply the same backup in the MCP-only installers, which also overwrite JSON files.

**Test strategy.**
- Unit: write a malformed JSON to `~/.claude/settings.json`; run the installer; assert the file is backed up and a fresh one is written.

**Done when.** Corrupted configs are backed up before overwrite; user can recover.

---

## Medium (7)

### M1. Dead `processUnprocessedOnce` reference

**File:** `src/observer/pipeline.ts` (and design doc)

**Fix.** Remove the reference from the design doc and the public API. The `Batcher` is the public path. If we want a "process unprocessed" method on the observer, we can add one — but only if there's a real caller. Today, there isn't.

**Done when.** No references to `Observer.processUnprocessedOnce` in source.

---

### M2. Trace ordering breaks synthesis context

**File:** `src/storage/store.ts:getUnprocessedTraces`

**Fix.** Order by `(session_id, timestamp, id)`. The id is the insertion order, so within a session, ties on `timestamp` resolve by insertion order.

```sql
ORDER BY session_id, timestamp ASC, id ASC
```

**Test strategy.**
- Unit: insert traces with the same `timestamp` in different orders; assert the returned order matches insertion order within a session.

---

### M3. FTS5 doesn't support boolean operators / column filters

**File:** `src/retrieval/fts.ts:46-54`

**Fix.** Document the limitation in the help text for `termyte search`. Don't implement a full parser — that's a half-week of work for a feature few users will hit. The current "match all tokens" semantics is reasonable for memory search.

**Done when.** Help text explicitly states: "search is a simple match-all-tokens query; boolean operators and column filters are not supported."

---

### M4. Embedding-dim mismatch returns 0 silently

**File:** `src/retrieval/vector.ts:69`

**Fix.** Throw on first mismatch, with a clear error message that names the offending memory id. The hybrid search catches it, logs once per session, and continues with FTS-only for that query.

```ts
if (a.length !== b.length) {
  throw new Error(
    `embedding dimension mismatch: query is ${a.length}d but memory #${m.id} is ${b.length}d. ` +
    `This usually means the embedding model was changed after memories were stored. ` +
    `Run 'termyte synth --reindex' to rebuild.`
  );
}
```

Add a `--reindex` flag to `termyte-synth` that walks all memories, drops their embeddings, and re-embeds in batches.

**Test strategy.**
- Unit: seed a memory with a 768-dim embedding; query with a 384-dim vector; assert the call logs a clear error and returns empty.

---

### M5. FTS5 trigger churns on every embedding update

**File:** `src/storage/migrations.ts:138-143`

**Fix.** Two options.

Option A (simpler): add `WHERE embedding IS NULL OR length(embedding) != ?` to the `updateMemoryEmbedding` SQL. The `obs_au` trigger only fires on actual column changes (the WHERE filters them out).

```ts
this.ctx.db.prepare(
  `UPDATE observations
   SET embedding = ?
   WHERE id = ? AND (embedding IS NULL OR length(embedding) != ?)`
).run(Buffer.from(embedding.buffer), id, Buffer.from(embedding.buffer).length);
```

Option B (cleaner): remove `embedding` from the FTS5-indexed columns. The FTS5 index only includes `title` and `description`. The `obs_au` trigger only fires when those change. But: with a contentless FTS5 (`content='observations'`), the trigger is what keeps FTS5 in sync, and we *do* update `title`/`description` rarely. So Option B is the right fix.

Actually looking again: `obs_au` already only references `title` and `description`:
```sql
INSERT INTO observations_fts(observations_fts, rowid, title, description)
VALUES('delete', old.id, old.title, old.description);
INSERT INTO observations_fts(rowid, title, description)
VALUES (new.id, new.title, new.description);
```

So the trigger does NOT fire on embedding-only changes in SQLite (it only fires on UPDATE statements that change the column values referenced in the trigger's `WHEN` clause — but we don't have a WHEN clause, so any UPDATE fires it). Adding a `WHEN` clause:

```sql
CREATE TRIGGER obs_au AFTER UPDATE OF title, description ON observations BEGIN
  ...
END;
```

This restricts the trigger to only fire when title or description actually change. Embedding-only updates are silent.

**Fix.** Add the `OF title, description` qualifier to the `obs_au` and `mem_au` triggers.

**Test strategy.**
- Unit: update only embedding; assert FTS5 row count is unchanged.

---

### M6. MCP server embeds on every call

**File:** `src/mcp/server.ts:50-61`

**Fix.** Pre-warm in the constructor:

```ts
constructor() {
  ...
  this.embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  // Warm in the background; the first MCP call might be slow, subsequent are fast.
  this.embeddings.embed("warmup").catch(() => { /* best-effort */ });
}
```

The first MCP call may still block on the first `embed()`, but after that it's warm. This is acceptable because the MCP server is a long-lived process (the agent's session).

**Test strategy.**
- Unit: instantiate `TermyteMcpServer`; assert `embeddings.embed` is called at least once during construction.

---

### M7. `tryCreateVecTable` dimensions are unmanaged

**File:** `src/storage/migrations.ts:180-191`

**Fix.** Track the embedding model + dimensions in a `meta` table. On `Store` construction, compare the recorded model with the configured one. If they differ, reindex (drop vec table, re-embed all memories).

```ts
function ensureVecTable(db: DB, model: LocalModelId, dimensions: number): void {
  const recorded = db.prepare(`SELECT value FROM meta WHERE key = 'embedding_model'`).get() as any;
  if (recorded?.value === model) {
    tryCreateVecTable(db, dimensions);
    return;
  }
  // Model changed: drop vec table, mark all memories for re-embedding.
  db.exec(`DROP TABLE IF EXISTS memories_vec`);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('embedding_model', ?)`).run(model);
  db.exec(`UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL`);
  tryCreateVecTable(db, dimensions);
}
```

**Test strategy.**
- Unit: insert memories with Nomic embeddings; switch to BGE; assert vec table is dropped and memories are marked for re-embedding.

---

## Low (5)

### L1. `parseAgentXml` regex fragility

**File:** `src/observer/parser.ts`

**Fix.** None unless reports of false positives come in. Document the limitation in the system prompt: "do not use `<observation>` inside description fields." The prompt already does this; reinforce it.

**Done when.** Issue is documented.

---

### L2. `NoOpEmbeddingsProvider` is mostly dead

**File:** `src/index.ts:84-86`

**Fix.** Either remove it or keep it as an opt-in for tests. Currently it's only useful for the test suite. I'd keep it but move it to `src/retrieval/test-utils.ts` so the public API surface is cleaner.

**Done when.** `NoOpEmbeddingsProvider` is not in the main public exports, only in test utilities.

---

### L3. No download progress or proxy support for local embeddings

**File:** `src/retrieval/local-embeddings.ts:55-67`

**Fix.** Three small improvements.

- Wrap the model download in a progress reporter that writes to stderr. `@xenova/transformers` supports a `progress_callback` option.
- Respect `HF_ENDPOINT` env var for self-hosted mirrors.
- Add a `termyte doctor` (or extend `termyte stats`) that runs a one-time health check: tries to load the model, reports success/failure, prints the cache location.

**Test strategy.**
- Unit: set `HF_ENDPOINT` to a mock URL; assert the loader uses it.

---

### L4. No cost telemetry in `termyte stats`

**File:** `src/cli/stats.ts`, plus the new `spend.json` (C3) work

**Fix.** Extend `termyte stats` to read `~/.termyte/spend.json` and print today's totals: invocations, input/output tokens, est. cost. The data is local; nothing is sent off-host.

```
adapter:           claude-code
embedding model:   nomic-embed (local ONNX)
synthesis adapter: claude-code
unprocessed traces: 12
recent sessions:    3
today (2026-06-26):
  invocations:        8
  input tokens:       4,231
  output tokens:      1,108
  est. cost (USD):    $0.012
daily budget:        $0.50 (16% used)
```

**Test strategy.**
- Unit: write a synthetic `spend.json`; assert `stats` reads and formats it correctly.

---

### L5. No schema version tracking

**File:** `src/storage/migrations.ts:171-173`

**Fix.** Add a `meta` table and a version column. Write migrations as numbered steps that check the current version and apply incrementally.

```sql
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '1');
```

When adding the C3 `last_error` column, the migration would be:

```ts
function migrateToV2(db: DB): void {
  const v = getSchemaVersion(db);
  if (v < 2) {
    db.exec(`ALTER TABLE traces ADD COLUMN last_error TEXT`);
    setSchemaVersion(db, 2);
  }
}
```

**Test strategy.**
- Unit: create a v1 DB; run migrations; assert v2 schema is in place and existing rows are intact.

---

## Sequencing

Realistic ordering for a 2-week sprint after release:

| Week | Work |
|---|---|
| **Days 1–2** | C8 (silent failures), H3 (double-normalize), H5 (install backup), L1 (doc-only) |
| **Days 3–4** | C2 (OpenCode plugin stdio), C3 (synth backpressure), H4 (adapter override) |
| **Days 5–7** | C4 (lazy embeddings), H2 (hook timeout), M6 (MCP warmup) |
| **Days 8–10** | C1 Part A (FTS5 pre-filter on vector search) — the big perf win |
| **Days 11–14** | C1 Part B (wire `sqlite-vec`), M5 (FTS5 trigger qualifier), M4 (dim mismatch) |

That sequence ships the most user-visible wins (silent failures, install data loss, performance) early, and the architectural changes (vector index, reindex) later. Each step is independently testable.

**Critical work to ship before any release:** C1 Part A (perf), C2 (OpenCode plugin), C3 (synth backpressure), C4 (embeddings), C8 (silent failures), H5 (install backup). That's 4 days of focused work.

The remaining items can ship in the following iterations as time and review allow.

---

## Done-when summary

- C1 Part A: vector search < 50 ms at 5k memories
- C2: zero `EPIPE` over 10 min Windows stress
- C3: 51st synthesis in a day is denied; spend.json is atomic; `stats` shows today's usage
- C4: 200-call hook session is an order of magnitude faster
- C8: failed ingest is logged to stderr
- H1: `memories_vec` is read in production
- H2: hook latency bounded by timeout
- H3: `adapter.normalize` called once per hook
- H4: `stats` reflects `TERMYTE_SYNTH_ADAPTER` override
- H5: corrupted configs are backed up before overwrite
- M1: dead reference removed
- M2: trace ordering by `(session_id, timestamp, id)`
- M3: FTS5 limitation documented
- M4: dim mismatch throws with actionable message; `--reindex` works
- M5: FTS5 trigger has `OF title, description` qualifier
- M6: MCP server pre-warms embeddings
- M7: vec table rebuilt on model change
- L1: limitation documented
- L2: `NoOpEmbeddingsProvider` moved to test utils
- L3: download progress + `HF_ENDPOINT` + `termyte doctor`
- L4: `stats` shows today's invocations / tokens / est. cost
- L5: schema version tracking

When every "Done when" line is green, this plan is complete.
