# Termyte — Critical Review of the Mitigation Plan

**Date:** 2026-06-26
**Scope:** Find better fixes, identify second-order effects, and catch reasoning errors in `docs/mitigation_plan.md`.

I read every line of the original plan against the current source. The plan is **mostly sound** but contains three reasoning errors that would lead to wasted work, two proposed fixes that are **worse than the problem they solve**, and a half-dozen second-order effects that would create new bugs if the fixes ship in isolation.

This document is organized as:
- **Reasoning errors** — claims in the plan that are factually wrong
- **Better fixes** — the plan's solution is OK but a different approach is better
- **Worse fixes** — the plan's solution introduces a new problem that outweighs the fix
- **Second-order effects** — the plan's solution is correct but cascades into a new bug
- **Revisions table** — concrete edits to apply to the plan

---

## 1. Reasoning errors (3)

### R1. C4 description is wrong about current behavior

**Plan claim:** "Replace the constructor's `this.ready = this.init()` with a getter pattern: the first call to `embed()` triggers init, subsequent calls reuse the warm model."

**Reality:** That is already what the code does. The `LocalEmbeddingsProvider.embed()` method already does `await this.ready` before doing real work (`src/retrieval/local-embeddings.ts:70-81`). The lazy-init pattern is already in place. The actual problem is not laziness — it is that **every `new LocalEmbeddingsProvider(...)` instance starts a fresh model load**, and the hook creates a new instance on every invocation.

The plan's *actual* fix (process-level singleton via the `_cachedEmbeddings` variable) is correct. The misleading description wastes the reader's time arguing with the wrong problem.

**Fix to the plan:** rewrite the "Part A — lazy init inside `LocalEmbeddingsProvider`" section. There is nothing to change inside the provider. The singleton lives in the CLI layer (`src/cli/hook.ts`).

---

### R2. C1 Part A description will mislead the implementer

**Plan claim:** "In `VectorSearch.search`, before the in-memory cosine, call `fts.search` for the query string and use the resulting memory ids as a candidate set."

**Reality:** `fts.search` returns the FTS5 hits as a candidate set. But the FTS5 query in `src/retrieval/fts.ts:46-54` is a *match-all-tokens* query, and the body of `fts.search` re-builds the same query every time. If the user query has 20 tokens, FTS5 returns memories that contain *all* of them, which is a much smaller candidate set than we want for a "fuzzy semantic" search. This is correct for the design goal ("pre-filter") but the plan should call out that the FTS5 query in `fts.ts` is doing AND-of-tokens, not OR.

**Why this matters:** the implementer, reading the plan, may think FTS5 returns a generous candidate set. It does not. If the user query is `"authentication uses JWT HS256"` and only 3 memories have all four tokens, the vector search runs against 3 candidates — missing 50 memories that are semantically similar but don't share all tokens.

**Fix to the plan:** clarify that the FTS5 pre-filter is a *strict* pre-filter. For queries with rare tokens, the candidate set is small. The mitigation plan should also note that this is a known limitation of the FTS5 query construction, and that a follow-up could rewrite `buildFTSQuery` to support OR-of-tokens (a one-line change: replace `"${t}"` with `${t}*` to use FTS5 prefix matching, or wrap the whole query in `OR` clauses).

---

### R3. C8 will break the lock file format

**Plan claim:** Add a `last_error TEXT` column to `traces`.

**Reality:** The plan claims this is a "non-destructive migration." That is correct *for SQLite* (`ALTER TABLE ADD COLUMN` is non-destructive). But the plan's proposed change to `processRaw` returns `{ handled: boolean; error?: string }`. This change ripples through:

- `src/hooks/runner.ts:32-38` — `processRaw` returns boolean; signature change
- `src/cli/hook.ts:58` — `await runner.processRaw(...)` ignores return value; needs to log
- `src/cli/hooks/runner.ts` — `processForResult` also calls `processRaw`; signature change
- All test files that mock `processRaw` — currently `test/hooks.test.ts:27,51,70,107` assert boolean
- `src/integrations/opencode-plugin/index.ts:71` — fires `termyte-hook` and doesn't care about the return value (correct), but the hook's error now needs to reach the user

The plan does not mention any of these. Implementing C8 requires touching ~6 files and updating 4 tests. Estimate: 2 hours, not the 1 hour the plan claims.

**Fix to the plan:** add a "Cascading changes" section under C8 listing every callsite.

---

## 2. Better fixes (4)

### B1. C2 should also fix the synth spawner, not just the OpenCode plugin

**Plan claim:** Apply the same `child.stderr.resume()` and `child.unref()` pattern to `fireTermyteSynth`.

**Plan is incomplete.** The `summarize.ts` handler's `fireTermyteSynth` already uses `stdio: "ignore"` so the stderr-blocking issue is moot. But the bigger problem with `fireTermyteSynth` is that **it has no timeout**. A detached `termyte-synth` process that hangs forever (waiting on a slow `claude -p`, or stuck on stdin) leaks until the user's machine runs out of PIDs. On Linux/macOS the default process limit per user is usually 32768; on Windows the per-process handle limit is much lower.

**Better fix:** the synth spawn should:

1. Capture the child's PID
2. Set an `alarm()` / `setTimeout()` that kills the child after a configurable timeout (default 10 min — `termyte-synth` already has `--timeout-ms`, but the spawner doesn't pass it)
3. Log the PID to a registry file so a future cleanup pass can reap orphans

The plan also misses a much simpler improvement: **the `summarize` handler should pass `--timeout-ms` to the synth subprocess**, derived from the agent's hook timeout. Today the synth defaults to 5 minutes regardless. The agent's `Stop` hook timeout is 60 s for Claude Code, so the synth is allowed to run 5× longer than the agent is even waiting.

**Revised C2 fix:**

```ts
function fireTermyteSynth(sessionId: string, cwd: string): void {
  const entry = resolveSynthEntry();
  if (!entry) return;
  const timeoutMs = Math.max(60_000, parseInt(process.env.TERMYTE_SYNCH_TIMEOUT_MS ?? "300000", 10));
  const child = spawn(process.execPath, [entry, "--session", sessionId, "--once", "--timeout-ms", String(timeoutMs)], {
    cwd, stdio: "ignore", windowsHide: true, detached: true, env: process.env,
  });
  child.on("error", () => { /* best-effort */ });
  child.unref();
  // Best-effort reaper. On Windows, process.kill with a detached
  // child requires the PID; we recorded it.
  setTimeout(() => {
    try { child.kill(); } catch { /* already dead */ }
  }, timeoutMs + 5_000).unref();
}
```

**Cost to add:** 10 minutes on top of the original C2 estimate.

---

### B2. C3 should share a budget file with C20 (cost telemetry)

**Plan claim:** `spend.json` lives at `~/.termyte/spend.json`. Writes happen during synthesis.

**Better fix:** the same file is read by `termyte stats` (C20). The two fixes should ship together as a single module `src/synth/spend.ts` with `recordInvocation(adapterId, usage)` and `readToday()`. The plan lists them as separate items but the file is the same. Combining reduces surface area and avoids the risk of the two implementations drifting.

**Revised C3:** "Build `src/synth/spend.ts` that records per-invocation usage and exposes `readToday()`. C20 (cost telemetry) reads from this same file." Add a note that the spend file is append-only within a day, rotated to a new file at midnight.

---

### B3. M5 should also add the `OF title, description` qualifier to the FTS5 triggers

**Plan claim:** The fix is correct.

**Better fix:** also add `WHEN (old.title <> new.title OR old.description <> new.description OR length(old.title) <> length(new.title) OR length(old.description) <> length(new.description))` if any column is nullable. The simpler `OF` qualifier is fine because `title` is `NOT NULL` and the trigger references both. But: with `OF title, description`, an update that sets `title = title` *still* fires the trigger in some SQLite versions (the `OF` qualifier filters columns, not values). Test this with a real UPDATE statement that doesn't change the value, and add a value-comparison guard if needed.

This is a small but real concern: the plan is correct in spirit but may not eliminate the churn in all cases.

**Revised M5 fix:** add the `OF` qualifier *and* a manual guard in `updateObservationEmbedding` to no-op if the embedding is unchanged.

---

### B4. C1 Part B should not silently swap Nomic → BGE on user error

**Plan claim:** "When the user changes embedding models (Nomic → BGE), the meta.embedding_dim change triggers a reindex."

**Better fix:** a user typo (passing `--model bge-small` once on the CLI) should not silently re-embed every memory in the database. Re-embedding is destructive: the original `embedding` column is set to NULL, and `memories_vec` rows are dropped. If the user re-runs the command with Nomic immediately after, they have to re-embed again from scratch.

The fix should:

1. **Require an explicit `--reindex` flag** to switch models. The current `TERMYTE_EMBED_MODEL_LOCAL` env var or `config.embeddings.model` is for new databases only.
2. **Confirm with a prompt** in the CLI: "You are about to re-embed 5,000 memories with `bge-small`. This will take ~10 minutes and cannot be undone. Type 'yes' to continue."
3. **Back up the old embeddings** to a side table (`memory_embeddings_old`) so the user can revert.

The plan's "drop vec table, mark all memories for re-embedding" is the right mechanism but it should not be automatic.

**Revised C1 Part B:** "Model change requires explicit `--reindex` flag, prompts for confirmation, backs up old embeddings to `memories_backup` table before drop."

---

## 3. Worse fixes (3)

### W1. M7's "drop vec table and re-embed" creates an availability hole

**Plan claim:** "If [model] differs, drop vec table, re-embed all memories."

**Why this is worse than the problem:** in the time between the drop and the re-embed completion, **vector search is broken**. Any user query during that window falls back to FTS-only (which works) but the fallback is silent — there's no warning. A user who doesn't notice will think vector search is working.

The bigger problem: re-embedding 5,000 memories takes ~10 minutes with the local model. During those 10 minutes, every new trace that comes in is *also* embedded with the *new* model, but the *old* memories are still embedded with the *old* model. **The corpus is in a mixed state** for 10 minutes, and any query that returns a mix will have a confusing ranking.

**Better fix:** the reindex is a two-step process.

1. **Phase 1 — shadow embed.** Embed everything with the new model into a `memories_vec_new` table. The old `memories_vec` is still authoritative. Vector search uses the old one.
2. **Phase 2 — atomic swap.** When the shadow is complete, drop the old `memories_vec` and rename `memories_vec_new` to `memories_vec`. Atomic in SQLite (rename is one operation).

This way the corpus is never in a mixed state. Vector search is always consistent.

**Revised M7 fix:** "Use a shadow table pattern. Build `memories_vec_new` in the background; swap atomically when complete."

---

### W2. M6's "pre-warm in constructor" couples MCP server startup to network/disk

**Plan claim:** "Pre-warm in the constructor: `this.embeddings.embed('warmup').catch(...)`."

**Why this is worse:** the constructor now does a network round-trip (or a 200 ms disk read) before the server is ready to accept connections. The MCP protocol requires `initialize` to respond quickly. If the warmup blocks, the MCP client (the agent) times out.

Worse: if the warmup *fails* (network down, model corrupted), the catch swallows the error. The first real `search_memories` call then either:
- Returns empty (if the search has a FTS-only fallback), silently.
- Throws an unhandled error (if it doesn't).

The user has no idea vector search is broken.

**Better fix:** the warmup should be *optional* and *non-blocking*.

1. The MCP server responds to `initialize` immediately, marking capabilities.
2. The warmup is fired-and-forgotten on a `setImmediate` after the response is sent.
3. The first `search_memories` call awaits `embeddings.ready` with a 2 s timeout. If not ready, the call returns FTS-only results with a warning field.

**Revised M6 fix:** "Defer warmup to a `setImmediate` after the first `initialize`. The first `search_memories` call awaits readiness with a 2 s timeout; if not ready, returns FTS-only with `warnings: ['vector_search_unavailable']` in the response."

---

### W3. C5 (now part of C1 Part B) is the wrong fix for silent failures

**Plan claim:** Add a `traces.last_error TEXT` column; on failed ingest, set the error and don't enqueue.

**Why this is worse:** the plan's `last_error` is a string, not structured. A user looking at the DB has no programmatic way to distinguish "missing session" from "JSON parse error" from "DB constraint violation". The fix hides the problem rather than exposing it.

**Better fix:** use structured fields instead of a string:

```sql
ALTER TABLE traces ADD COLUMN ingest_status TEXT;
ALTER TABLE traces ADD COLUMN ingest_error TEXT;
ALTER TABLE traces ADD COLUMN ingest_attempts INTEGER DEFAULT 0;
```

- `ingest_status`: `'ok' | 'failed' | 'skipped'`
- `ingest_error`: human-readable message
- `ingest_attempts`: count of retry attempts (so we can back off retries)

Then `termyte stats` can show: "12 traces failed to ingest in the last hour" with a `--show-failed` flag to dump them.

**Revised C8 fix:** "Use structured ingest_status / ingest_error / ingest_attempts columns. Stats command surfaces the failure count."

---

## 4. Second-order effects (6)

### E1. C1 Part A's FTS5 pre-filter changes the vector rank interpretation

When `VectorSearch.search` receives a candidate set from FTS5, the cosine similarity is computed against that smaller set. The ranking is now *"within FTS5 candidates"*, not *"across all memories"*. A memory that scores 0.9 cosine but is not in the FTS5 set is invisible.

This is fine — the hybrid search's RRF combination handles it — but the **vector search in isolation no longer gives the same results it used to**. If any test asserts on a specific `vectorResults` ordering, that test will break.

**Mitigation:** update the existing `test/retrieval.test.ts` vector-search tests to assert *which memory is in the top-N* rather than *the absolute cosine ranking*.

---

### E2. C3's atomic rename of `spend.json` doesn't survive concurrent writes

The plan uses "atomic temp-file rename" for the spend file. This works *if* there is exactly one writer at a time. The current `Lock` ensures only one `termyte-synth` runs at a time, so writes are serialized.

But: the plan also says `termyte stats` reads the file. `termyte stats` runs in a separate process. A read-during-write is safe *if* the OS guarantees atomic rename (Linux and macOS do; Windows does for files in the same directory on NTFS). But if the user is on a FAT32 or exFAT drive (USB sticks, SD cards), atomic rename is not guaranteed and the file can be read mid-rename as a zero-byte file.

**Mitigation:** add a checksum inside `spend.json` so a partial read is detectable. `stats` falls back to "data unavailable" rather than reporting $0.

---

### E3. M5's FTS5 trigger change can break reindex

If the FTS5 trigger only fires on title/description changes, and we later add a "rename observation" feature that changes only the title, the trigger fires correctly. But: if a future schema migration adds a column to the `observations` table, and a user script does a full-table UPDATE for backfill, the trigger fires for every row, even when title/description are unchanged.

This is a future concern but worth documenting.

**Mitigation:** add a comment in the migration: "Re-evaluate trigger conditions on schema changes. The `OF title, description` qualifier assumes these are the only indexed columns."

---

### E4. B1's PID-tracking in `fireTermyteSynth` has a Windows gotcha

On Windows, `child.kill()` on a detached process requires the PID and the proper signal. Detached processes on Windows are *not* in a process group by default (unlike POSIX), so killing the parent doesn't reap the child. The PID-based kill in the `setTimeout` should work, but only if the process is still alive and the OS hasn't recycled the PID (PID recycling is a real concern after 4 billion PIDs — unlikely but not impossible).

**Mitigation:** write the child's PID to `~/.termyte/synth.pid` on spawn. On the next `termyte-synth` start, read the file, check if the PID is alive, and if so, kill it before acquiring the lock. This handles the case where a previous `termyte-synth` was orphaned.

---

### E5. H5 (install backup) interacts poorly with the OpenCode plugin installer

The plan adds backup-on-overwrite to the JSON-config installers. The OpenCode plugin installer copies a *file* (`termyte.js` plugin) to `~/.config/opencode/plugins/`, not just edits JSON. If the user has a hand-edited `termyte.js` (say, with a custom prompt), the install overwrites it without a backup.

**Mitigation:** backup the destination file before `copyFileSync` if it exists. Same `.bak.<timestamp>` pattern.

---

### E6. M4's `--reindex` flag needs to be re-entrant

If `termyte synth --reindex` is interrupted (Ctrl+C, machine sleep, OOM), the partial reindex leaves the corpus in a mixed state. The plan's M4 doesn't address this.

**Mitigation:** write reindex progress to a checkpoint file (`memories_reindex_state.json`). On startup, check for an incomplete reindex and either resume or roll back. The shadow-table pattern from W1 makes this easier: the reindex only writes to `memories_vec_new`, and the swap is atomic. An interrupted reindex is harmless because the old table is still authoritative.

---

## 5. Missing items (3)

The plan does not address three issues that came up in the review:

### M0a. C1 Part B requires the embedding model to be loadable in the CLI process

When the worker reindexes via the local ONNX model, it needs the `LocalEmbeddingsProvider` to work in `termyte-synth`. But the `termyte-synth` CLI today constructs it (line 99) and discards it (`void embeddings`). The reindex needs to actually use it.

**Add to C1 Part B:** "The reindex path uses `LocalEmbeddingsProvider` directly. `termyte synth` must call `await embeddings.embed(text)` for each memory's text and update the row + the vec table."

---

### M0b. The plan's `termyte-synth --reindex` is not in the help text

C1 Part B and M4 both reference `--reindex`. The synth CLI's help text (lines 33-50) does not list it. Update the help text.

---

### M0c. The plan does not address the `OpenAICompatibleProvider` leftover

The senior review's #1 was the O(n) vector search. The implementation of the *fix* (C1 Part B) introduces a new dependency on the local embeddings model for the reindex. But the existing `OpenAICompatibleProvider` (in `src/observer/openai-provider.ts`) is still used for *observation extraction* in the in-process `Observer` (which the synth CLI does not use, but the legacy hook path does). The plan's discussion of "embeddings are now local" is true for the new path but the old `Observer` class still talks to OpenAI.

**This is a contradiction in the design narrative.** The plan should explicitly say: "The legacy in-process `Observer` (used by `termyte-hook` with the old LLM-driven observation extraction) is unchanged. The new `Batcher` (used by `termyte-synth`) does not need an LLM; it just passes the raw trace XML to the agent and lets the agent extract. The OpenAI dependency is now only triggered when `TERMYTE_USE_DEDICATED_LLM=1` is set."

---

## 6. Revisions to apply to `docs/mitigation_plan.md`

Concrete edits, in order of priority:

| ID | Section | Edit |
|---|---|---|
| 1 | C4 | Replace "lazy init inside `LocalEmbeddingsProvider`" section. The provider is already lazy; the fix is purely a process-level singleton in the CLI. Drop the misleading claim. |
| 2 | C1 Part A | Add a note: FTS5 query uses AND-of-tokens, so the candidate set can be very small for queries with rare terms. A follow-up may switch FTS5 to OR-with-prefix matching. |
| 3 | C8 | List the 6 callsite changes required (4 test updates + 2 production files). Update effort estimate to 2 hours. |
| 4 | C2 | Add the missing spawner improvement: `--timeout-ms` passed to the synth subprocess, PID-based reaper after timeout. New sub-bullet under the fix. |
| 5 | C3 | Merge with C20: single `src/synth/spend.ts` module, written once, read by both `synth` and `stats`. |
| 6 | M5 | Add a value-comparison guard in `updateObservationEmbedding` alongside the trigger qualifier. |
| 7 | C1 Part B / M7 | Require explicit `--reindex` flag with confirmation prompt and backup table. Use a shadow-table swap pattern (W1's better fix). |
| 8 | M6 | Defer warmup to a `setImmediate` after `initialize`. Add 2 s readiness timeout in the search path. |
| 9 | C5 | Replace the `last_error` string with structured `ingest_status` / `ingest_error` / `ingest_attempts` columns. |
| 10 | C1 Part B | Add the requirement that the reindex uses `LocalEmbeddingsProvider` (item M0a). |
| 11 | C1 Part B | Add the `--reindex` flag to the `termyte-synth` help text (item M0b). |
| 12 | C20 (or as new section) | Clarify that `OpenAICompatibleProvider` is still used by the legacy `Observer` path; the new `Batcher` path does not need it (item M0c). |
| 13 | H5 | Apply backup-on-overwrite to the OpenCode plugin installer too (item E5). |
| 14 | M4 | Use shadow-table reindex; add checkpoint file for re-entrancy (items W1, E6). |
| 15 | B1 | Add PID-tracking + zombie reaper on next `termyte-synth` start (item E4). |
| 16 | E2 | Add checksum to `spend.json` for safe read-during-write on FAT32/exFAT. |
| 17 | New section | "Cascading changes for C8": list all files that need updating. |
| 18 | Sequencing | Add 1 hour for C3/C20 combination work. Add 1 hour for C8's expanded test updates. |
| 19 | Sequencing | Move H5 (install backup) earlier — it's a 30-minute data-safety fix. |

---

## 7. Summary

The plan is **80% correct** but has three classes of issues that would have caused real problems if implemented as written:

1. **Reasoning errors** (R1–R3) — three sections describe the problem wrong or the cascade wrong. Implementing them as written would either not fix the problem (R1) or fix it incompletely (R2) or take longer than estimated (R3).

2. **Worse fixes** (W1–W3) — three proposed solutions create new problems. The vec-table reindex without a shadow table is the worst: a 10-minute window where the corpus is in a mixed state.

3. **Second-order effects** (E1–E6) — six interactions with existing code or future code that the plan doesn't address. Most are minor. The most concerning is E5 (OpenCode plugin installer overwrites user customizations) because it inverts a data-safety guarantee the rest of the plan depends on.

**My recommendation:** apply the 19 edits in §6 before any work begins. Total time impact: +3 hours on the original 14-day plan. The revised plan is more honest about scope, has fewer landmines, and produces a result that is easier to maintain.

If you want, I can apply the revisions directly to `docs/mitigation_plan.md` and produce a v2 of the document.
