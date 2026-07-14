# Termyte Context Engine v0.1 Implementation Plan

Date: 2026-07-14
Design: `docs/superpowers/specs/2026-07-11-termyte-context-engine-v0.1-design.md`

## Goal

Ship the approved Claude Code and Codex context compiler by hardening the existing local runtime. The implementation must bound synthesis work by episode, rank every context source through one explainable candidate contract, preserve evidence and correction provenance, and prove the result from a packed installation.

## Constraints

- Reuse SQLite, the leased job queue, current providers, FTS/vector retrieval, hooks, packet records, and Viewer.
- Add no runtime dependency, service, graph database, learned ranker, or worker pool.
- Keep hook work deterministic, redacted, fail-open, and below the existing latency target.
- Preserve old databases and queued trace jobs through compatibility migrations.
- Do not claim outcome causality.
- Keep only `init`, `viewer`, `doctor`, `uninstall`, and `help` on the public CLI.

## Delivery order

```text
Baseline truth
  -> bounded episode synthesis
  -> Git/evidence/outcome provenance
  -> unified context compiler
  -> feedback and correction safety
  -> Viewer explanations
  -> public CLI cleanup
  -> evaluation and packed release proof
```

Runtime throughput precedes richer retrieval because the current queue can grow faster than the worker drains it. Viewer work follows persisted truth so the UI does not invent a second interpretation layer.

## Milestone 0: Make the baseline trustworthy

### Task 0.1: Remove the package self-dependency

Files:

- Modify: `package.json`
- Modify: `package-lock.json`
- Verify: `test/packaging.test.ts`

Steps:

1. Add an assertion to `test/packaging.test.ts` that the package does not list `termyte` in dependencies, optional dependencies, or dev dependencies.
2. Confirm the assertion fails against the current manifest.
3. Remove `"termyte": "^1.0.2"` and regenerate only the lockfile metadata required by that removal.
4. Run the packaging test, typecheck, and build.

Acceptance:

- `npm ls termyte --all` contains only the workspace root.
- A packed install resolves all runtime dependencies without installing a nested Termyte copy.

Commit: `fix: remove package self-dependency`

### Task 0.2: Separate fast tests from the packed-install gate

Files:

- Modify: `package.json`
- Modify: `vitest.config.ts` only if command-line exclusion cannot express the split
- Verify: `test/installed-pipeline.test.ts`

Steps:

1. Keep the ordinary test command focused on repository tests and exclude the long packed-install test.
2. Add a `test:package` script that runs only `test/installed-pipeline.test.ts` in isolation with its existing timeout.
3. Add a `verify` script that runs typecheck, build, ordinary tests, then the package test serially.
4. Run each script independently and then run `verify`.

Acceptance:

- The ordinary suite has no worker RPC timeout.
- The isolated packed-install test still proves install, initialization, capture, injected worker failure, restart, recovery, memory creation, and doctor output.

Commit: `test: isolate packed installation gate`

## Milestone 1: Bound background synthesis by episode

### Task 1.1: Add one coalescing queue operation

Files:

- Modify: `src/pipeline/job-queue.ts`
- Modify: `test/job-queue.test.ts`

Steps:

1. Add failing tests for `coalesceJob`:
   - repeated pending work for the same kind and episode reuses one row;
   - a later event pushes `next_run_at` forward to the idle deadline;
   - a succeeded row can be reset for a later episode generation;
   - failed work resets only when explicitly refreshed;
   - leased work is never stolen or reset.
2. Implement `coalesceJob` with the existing unique `(kind, subject_type, subject_id, dedupe_key)` key and one SQLite upsert.
3. Reset attempts and errors only when transitioning a non-leased row back to pending.
4. Leave `enqueueJob` semantics unchanged for existing jobs.

Acceptance:

- One episode and synthesis kind has at most one pending row.
- Lease ownership and retry behavior remain unchanged.

Commit: `feat: coalesce episode synthesis jobs`

### Task 1.2: Replace per-trace extraction with episode batches

Files:

- Modify: `src/pipeline/job-queue.ts`
- Modify: `src/pipeline/memory-pipeline.ts`
- Modify: `src/observer/pipeline.ts`
- Modify: `src/observer/prompts.ts`
- Modify: `src/hooks/runner.ts`
- Modify: `src/cli/worker.ts`
- Modify: `test/memory-pipeline.test.ts`
- Modify: `test/observer.test.ts`
- Modify: `test/hooks.test.ts`
- Modify: `test/integration.test.ts`

Steps:

1. Add the durable job kinds `synthesize_episode` and `consolidate_episode` with episode subjects.
2. Add `MemoryPipeline.ingestEpisode(episodeId, nextRunAt)` and expose it through `Observer.enqueueEpisode`.
3. Have `HookRunner` retain the episode ID returned by `ExperienceRecorder.record` and coalesce synthesis for eligible tool events. Use a short configurable-in-code idle delay; session end schedules immediately.
4. Make `synthesize_episode` load at most 50 eligible, not-yet-complete traces from the episode and call the current LLM provider once with a batch prompt.
5. Persist each valid observation with every supporting trace ID, then enqueue ordinary embedding work and one `consolidate_episode` job.
6. Make `consolidate_episode` load all indexed, unprocessed observations supported by the episode and invoke consolidation once for that group.
7. Preserve the existing embedding, memory indexing, deduplication, decay, verification, retry, and dead-letter paths.
8. After a leased episode job finishes, compare the processed trace watermark with the latest episode trace. If a trace arrived during synthesis, mark the job succeeded first and coalesce one follow-up generation.
9. Keep old `extract_observation` and `consolidate_memory` handlers only as compatibility drains for already-persisted jobs; stop creating new jobs of those kinds.
10. Add a queue read for the earliest scheduled `next_run_at`. Let the detached worker wait only until the bounded episode-idle deadline and then claim work, so an abandoned session is synthesized without requiring another hook event.

Acceptance:

- A 100-tool-event episode creates no more than one pending episode extraction and one pending episode consolidation job at a time.
- The fake provider sees batch calls rather than one extraction and one consolidation call per trace.
- A trace arriving during a lease is processed by exactly one follow-up job.
- An abandoned episode is synthesized after the idle deadline without polling indefinitely.
- A provider outage leaves capture intact and retryable work visible.

Commit: `feat: synthesize memories by episode`

### Task 1.3: Delete the parallel batch runtime

Files:

- Delete: `src/synth/batcher.ts`
- Modify: `src/index.ts`
- Modify or delete: `src/cli/synth.ts`
- Modify: `test/synth.test.ts`
- Modify: `test/synth-cli.test.ts`
- Retain: `src/synth/prompts.ts` only if the durable pipeline imports its redaction-safe batch prompt

Steps:

1. Move any uniquely required batch prompt/parser coverage to the durable pipeline tests.
2. Remove the standalone `Batcher` export and execution path.
3. Keep provider adapters only where still used by capability discovery or tests; do not delete unrelated provider support in this task.
4. Confirm there is one production owner of trace-to-observation synthesis: `MemoryPipeline`.

Acceptance:

- No production code can process the same captured trace through a second batch architecture.
- Redaction prompt tests continue to pass.

Commit: `refactor: remove duplicate synthesis batcher`

### Task 1.4: Expose backlog age and throughput

Files:

- Modify: `src/pipeline/job-queue.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/cli/doctor.ts`
- Modify: `test/job-queue.test.ts`
- Modify: `test/doctor.test.ts`

Steps:

1. Extend queue diagnostics with oldest pending age, ready count, and jobs completed in the last minute.
2. Calculate the values directly from persisted job timestamps; add no metrics table.
3. Include the fields in health diagnostics and JSON doctor output.
4. Define degraded health when ready work exceeds a bounded age, not merely when pending count is nonzero.

Acceptance:

- Counts and ages match fixture timestamps exactly.
- Diagnostics distinguish a healthy delayed idle job from an overdue backlog.

Commit: `feat: report queue age and throughput`

## Milestone 2: Ground experience in repository state

### Task 2.1: Capture compact Git state without blocking agents

Files:

- Add: `src/experience/git-state.ts`
- Modify: `src/experience/recorder.ts`
- Modify: `src/storage/store.ts`
- Modify: `test/experience-recorder.test.ts`
- Add: `test/git-state.test.ts`

Steps:

1. Implement a small fail-soft helper using `execFileSync` with argument arrays, ignored stderr, and a strict timeout.
2. Read only:
   - `git rev-parse HEAD`;
   - changed file names from staged and unstaged diffs;
   - compact `git diff --stat` metadata at episode close.
3. On episode start, persist `base_commit` when available.
4. On episode close, persist `final_commit` and one normalized `diff` evidence record containing changed paths and compact stats.
5. Normalize repository-relative paths and reject paths outside the workspace.
6. Return null/empty state for non-Git workspaces, timeouts, and unavailable Git.

Acceptance:

- Temporary-repository tests prove base commit, final commit, changed paths, and diff evidence.
- Non-Git and timed-out Git calls do not fail capture.
- No full patch or unredacted file content is persisted.

Commit: `feat: capture git evidence for episodes`

### Task 2.2: Link outcomes to the exact injected packet

Files:

- Modify: `src/storage/store.ts`
- Modify: `src/experience/recorder.ts`
- Modify: `src/cli/handlers/context.ts`
- Modify: `test/experience-recorder.test.ts`
- Modify: `test/ctx-001-injections.test.ts`
- Modify: `test/handlers.test.ts`

Steps:

1. Add a store query that resolves the latest injection whose packet belongs to an episode.
2. Keep context creation after prompt capture so the active episode ID is always passed into `ContextBuilder`.
3. At session end, record an append-only inferred outcome row instead of only updating episode status, and attach the exact injection ID when present.
4. Prefer explicit Viewer/human outcomes over inferred outcomes when rendering the current episode result; never delete the inferred history.
5. Keep `unknown` when no executable evidence supports success or failure.

Acceptance:

- Episode detail can traverse episode -> packet -> injection -> outcome.
- A session without context records a valid null injection.
- Merely showing context does not mutate memory utility.

Commit: `feat: associate task outcomes with injections`

### Task 2.3: Persist evidence-level memory provenance

Files:

- Modify: `src/storage/migrations.ts`
- Modify: `src/storage/store.ts`
- Modify: `src/core/types.ts`
- Modify: `src/pipeline/memory-pipeline.ts`
- Modify: `test/store.test.ts`
- Modify: `test/memory-pipeline.test.ts`
- Modify: `test/explain.test.ts`

Steps:

1. Add a `memory_evidence(memory_id, evidence_id)` join table with foreign keys and cascade behavior.
2. Add store methods to link memory records to evidence supported by their source traces and episode.
3. During episode consolidation, attach only evidence from the same episode and supporting traces.
4. Extend memory explanation output with evidence IDs, kinds, and broken-link diagnostics.
5. Add an invariant query: every active memory must have valid trace/observation provenance or explicit evidence provenance.

Acceptance:

- Every newly active memory resolves to at least one persisted supporting record.
- Deleting an episode cascades evidence links without leaving false provenance.
- Explanation reports broken provenance instead of silently omitting it.

Commit: `feat: link memories to episode evidence`

## Milestone 3: Compile one explainable context packet

### Task 3.1: Introduce one typed candidate contract

Files:

- Add: `src/context/compiler.ts`
- Modify: `src/context/builder.ts`
- Modify: `src/core/types.ts`
- Modify: `src/storage/store.ts`
- Add: `test/context-compiler.test.ts`
- Modify: `test/ctx-001-injections.test.ts`

Steps:

1. Define one in-memory candidate shape containing kind, source ID, rendered text, token estimate, score components, lifecycle/applicability state, and rejection reason.
2. Generate candidates for:
   - current task/repository state;
   - hybrid-ranked memories and procedures;
   - recent observations;
   - the latest session summary/handoff;
   - evidence and episode previews related by exact path, command, test, or error tokens.
3. Add minimal store reads for recent repository evidence and episode previews. Do not create another search index.
4. Convert the current memory-only packet persistence to persist every considered candidate.
5. Remove fixed 10/30/60 summary/observation/memory token partitions and the separate `packSummary`, `packObservations`, and `packMemories` selection paths.
6. Replace the rendered `Inspect: termyte memory <id>` instruction with a stable memory ID; detailed inspection belongs in Viewer.

Acceptance:

- Summaries and observations can beat a weak memory and can also be rejected.
- Every rendered prior-context item has a matching selected candidate row.
- Every considered but excluded item has a stable rejection reason.
- Injected context does not advertise a hidden CLI command.

Commit: `feat: compile typed context candidates`

### Task 3.2: Apply deterministic eligibility and applicability

Files:

- Modify: `src/context/compiler.ts`
- Modify: `src/retrieval/eligibility.ts`
- Modify: `src/retrieval/ranking.ts`
- Modify: `src/core/types.ts`
- Modify: `test/context-compiler.test.ts`
- Modify: `test/ret-001-eligibility.test.ts`
- Modify: `test/retrieval.test.ts`

Steps:

1. Exclude wrong-repository, deleted, conflicted, superseded, broken-provenance, and missing-file candidates before ranking.
2. Keep stale candidates excluded unless they have an exact technical match; render the stale state when admitted.
3. Reuse `scoreMemoryCandidate` for memory relevance and expose its components through the generic candidate score.
4. Score non-memory candidates with only deterministic signals: exact path/error/test/command match, sparse relevance, evidence quality, recency, feedback, and token cost.
5. Treat exact current-commit and file overlap as boosts. Treat a missing referenced file as incompatibility. Do not add Git-history graph traversal.
6. Use normalized repository-relative paths across Windows and POSIX separators.

Acceptance:

- Exact path, test, command, and error matches outrank vague semantic similarity.
- Wrong-repository and unsafe lifecycle records never reach packing.
- Score components shown in packet records sum to the final score deterministically.

Commit: `feat: enforce context applicability`

### Task 3.3: Enforce the hard budget and abstention

Files:

- Modify: `src/context/compiler.ts`
- Modify: `src/context/builder.ts`
- Modify: `test/context-compiler.test.ts`
- Modify: `test/ctx-001-injections.test.ts`

Steps:

1. Include packet framing and headings in the token estimate before selecting candidates.
2. Sort by final score, then stable kind/source ID tie-breakers.
3. Reject redundant normalized content before token packing.
4. Greedily add whole candidates while budget remains; allow bounded truncation only for the first useful candidate and retain its provenance line.
5. Persist `below_threshold`, `redundant`, `token_budget`, `ineligible_lifecycle`, `wrong_repository`, `broken_provenance`, and `missing_file` reasons.
6. If no prior-experience candidate clears the threshold, persist an abstaining packet and return no injectable prior-context text.
7. Record `shown` only for selected memories after delivery is persisted.

Acceptance:

- Estimated packet tokens never exceed the requested budget.
- Repeated builds over identical persisted state produce identical selection order and reasons.
- A nonsense/adversarial query produces a packet record but no injected memory section.

Commit: `feat: add deterministic packing and abstention`

## Milestone 4: Make feedback and corrections safe

### Task 4.1: Store helpful and harmful as first-class events

Files:

- Modify: `src/storage/migrations.ts`
- Modify: `src/core/types.ts`
- Modify: `src/lifecycle/feedback.ts`
- Modify: `src/mcp/schemas.ts`
- Modify: `src/storage/store.ts`
- Modify: `test/lifecycle.test.ts`
- Modify: `test/mcp-schemas.test.ts`
- Modify: `test/fb-001-exposure.test.ts`

Steps:

1. Rebuild the SQLite feedback constraint compatibly to add `helpful` and `harmful` while preserving existing rows.
2. Keep `shown`, `used`, `ignored`, `downranked`, and `corrected` for historical and machine feedback.
3. Change `used` to record access/usage without increasing confidence or importance.
4. Let only explicit `helpful` feedback reinforce utility.
5. Make `harmful` immediately suppress default retrieval and apply a strong negative score.
6. Continue excluding automatic `shown` events from utility aggregation.

Acceptance:

- Shown and used success associations cannot create a positive feedback loop.
- Helpful is positive, ignored/downranked are negative, and harmful is immediately ineligible.
- Old databases migrate without losing feedback.

Commit: `feat: separate context exposure from utility`

### Task 4.2: Ground corrected replacements in new evidence

Files:

- Modify: `src/storage/store.ts`
- Modify: `src/pipeline/memory-pipeline.ts`
- Modify: `src/explain/memory-explain.ts`
- Modify: `test/cor-001-verification.test.ts`
- Modify: `test/eval/harness.test.ts`
- Modify: `test/explain.test.ts`

Steps:

1. When correction text has an injection, resolve its packet episode and insert `human_feedback` evidence there.
2. Create a replacement only when that new evidence exists. Otherwise mark the old memory conflicted and await more evidence.
3. Give the replacement the correction evidence link and no inherited source observation or trace IDs from the old claim.
4. Add the `supersedes` edge only after the replacement is active and indexed.
5. Suppress the old memory immediately while verification is pending.
6. Show both the correction evidence and supersession chain in memory explanation.

Acceptance:

- A corrected replacement never cites evidence that supports only the old statement.
- Correction without grounded text creates no unsupported active memory.
- Retrieval excludes the old claim before replacement indexing completes.

Commit: `fix: ground correction provenance`

## Milestone 5: Expose the truth in Viewer

### Task 5.1: Extend persisted Viewer responses

Files:

- Modify: `src/storage/store.ts`
- Modify: `src/viewer/routes.ts`
- Modify: `test/viewer.test.ts`

Steps:

1. Return queue ready count, oldest age, throughput, retries, and dead letters from diagnostics.
2. Return packets and injections with episode detail, including associated outcomes.
3. Return candidate score components and rejection reasons with packet detail.
4. Return evidence provenance, broken links, feedback, and correction edges with memory detail.
5. Validate `helpful`, `harmful`, `ignored`, and `corrected` directly instead of mapping them onto different stored events.

Acceptance:

- Every API count comes from persisted state.
- CSRF and localhost origin protections remain enforced.
- Invalid feedback cannot mutate memory state.

Commit: `feat: expose context decisions in viewer api`

### Task 5.2: Add the minimum diagnostic UI

Files:

- Modify: `src/viewer-ui/src/main.tsx`
- Modify: `src/viewer-ui/src/styles.css`
- Modify: `test/viewer.test.ts`

Steps:

1. Add queue age and throughput to Diagnostics.
2. Add the packet/injection/outcome chain to Episode detail.
3. Add selected and rejected candidate rows, score components, and reasons to packet detail.
4. Add memory applicability, evidence, broken provenance, and correction chain to Memory detail.
5. Add an explicit abstained state when a packet selected no prior context.
6. Reuse the existing four-page shell and styles; add no router, state library, or chart dependency.

Acceptance:

- A user can answer what was remembered, why it was selected or rejected, and what happened next without SQL.
- Empty, loading, degraded, and broken-provenance states are readable.

Commit: `feat: explain context lifecycle in viewer`

## Milestone 6: Enforce the five-command public product

### Task 6.1: Remove aliases and unreachable command branches

Files:

- Modify: `src/cli/index.ts`
- Delete: `src/cli/mvp-aliases.ts`
- Delete: `test/cli-mvp-aliases.test.ts`
- Add: `test/cli-surface.test.ts`
- Modify: `test/packaging.test.ts`

Steps:

1. Add a spawned-CLI test for the exact help surface.
2. Reduce `src/cli/index.ts` dispatch to `init`, `viewer`, `doctor`, `uninstall`, and help aliases.
3. Delete MVP alias resolution and the Viewer-only command list.
4. Return exit code 2 and a concise Viewer direction for unsupported former public commands.
5. Keep hook, worker, MCP server modules, and evaluation modules callable through internal imports/tests; do not expose new package binaries.

Acceptance:

- Help advertises exactly five public commands.
- Old aliases do not execute hidden behavior.
- `termyte-hook` and `termyte-worker` packaged binaries remain functional.

Commit: `refactor: enforce public cli boundary`

## Milestone 7: Prove retrieval and runtime claims

### Task 7.1: Repair the evaluation harness without answer leakage

Files:

- Modify: `src/eval/harness.ts`
- Modify: `src/cli/eval.ts`
- Modify: `src/retrieval/query-preprocessor.ts`
- Modify: `src/retrieval/fts.ts` only for demonstrated ranking defects
- Modify: `test/fixtures/regression-corpus/cases.json` only to correct invalid expectations, never to append answer keywords
- Modify: `test/eval/harness.test.ts`
- Modify: `test/retrieval.test.ts`

Steps:

1. Turn the current embedding-retry, CRUD ownership, FTS/BM25, and Viewer-health failures into isolated failing tests.
2. Fix each root cause in the shared path used by production.
3. Add exact technical token extraction for paths, commands, test names, and error signatures to query preprocessing.
4. Restore an explicit Recall@5 threshold of 0.90 only after the non-leaked corpus reaches it.
5. Keep MRR and precision as reported diagnostics; do not tune against hidden expected keywords.
6. Keep evaluation off the public CLI by making `node dist/cli/eval.js --json` the internal direct runner, with a nonzero exit code when the report fails.

Acceptance:

- `node dist/cli/eval.js --json` reports `passed: true` for maintained suites.
- Recall@5 is at least 0.90 on the checked-in, non-leaked corpus.
- FTS-only behavior passes with embeddings disabled or failing.

Commit: `fix: restore honest retrieval evaluation`

### Task 7.2: Align the MemoryAgentBench smoke fixture

Files:

- Delete: `test/fixtures/benchmarks/longmemeval-smoke.json`
- Add: `test/fixtures/benchmarks/memoryagentbench-smoke.json`
- Modify: `src/benchmark/datasets/memoryagentbench.ts` only if the loader contract is ambiguous
- Modify: `test/benchmark.test.ts`

Steps:

1. Define one documented MemoryAgentBench input shape with context chunks, question, answer, and stable IDs.
2. Replace the mismatched fixture with the smallest valid two-case smoke dataset.
3. Assert normalization, rejection of missing context, and one end-to-end benchmark run.
4. Keep MemoryAgentBench as the only public benchmark loader.

Acceptance:

- The smoke fixture loads and runs without a context-chunk mismatch.
- Invalid rows fail with row ID and missing field.

Commit: `fix: align memoryagentbench fixture contract`

### Task 7.3: Add the bounded-backlog and abstention release tests

Files:

- Add: `test/context-runtime-gate.test.ts`
- Modify: `test/installed-pipeline.test.ts`
- Modify: `test/worker-supervisor.test.ts`

Steps:

1. Replay 100 representative tool events into one episode with a fake provider.
2. Assert bounded pending episode work, eventual drain, complete trace provenance, and fewer model calls than traces.
3. Inject one provider failure and one expired lease; assert capture continuity and recovery.
4. Run a related task and assert a bounded packet with selected/rejected reasons.
5. Run an adversarial unrelated task and assert persisted abstention with no prior-context injection.
6. Repeat the core flow from the packed installation.

Acceptance:

- Queue depth is bounded by episode work rather than tool-event count.
- The packed runtime survives failure and produces the same packet semantics as the repository tests.
- No aggregate test-runner timeout returns.

Commit: `test: add context engine release gate`

### Task 7.4: Execute real-agent and paired product trials

Files:

- Add: `docs/evals/context-v0.1-trial-protocol.md`
- Store generated reports outside the npm package unless explicitly approved for publication

Steps:

1. Document deterministic task grading, environment capture, Termyte on/off assignment, repeated trials, and transcript review.
2. Complete one packed-install Claude Code flow and one packed-install Codex flow before broader trials.
3. Run at least 20 paired repeated-repository trials with Termyte on and off.
4. Record task success, context tokens, turns, tool calls, elapsed time, validations, failures, abstentions, and explicit context feedback where observable.
5. Review every harmful-context case and fix product regressions before release.
6. Report associations and confidence limits; do not convert the trial into a causal marketing claim.

Acceptance:

- Both supported agents pass end to end.
- At least one correct abstention is observed.
- Every harmful-context event has a written disposition.
- Product claims match measured evidence.

Commit: `docs: add context trial protocol`

## Final verification

Run from a clean worktree:

```powershell
C:\nvm4w\nodejs\npm.cmd run typecheck
C:\nvm4w\nodejs\npm.cmd run build
C:\nvm4w\nodejs\npm.cmd test
C:\nvm4w\nodejs\npm.cmd run test:package
node dist/cli/index.js doctor --json
node dist/cli/eval.js --json
```

Then verify the packed install manually with authenticated Claude Code and Codex.

Release is blocked by any of:

- unbounded or overdue episode work;
- active memory with broken provenance;
- unsafe lifecycle item entering a packet;
- packet exceeding its token budget;
- incorrect non-abstention on the adversarial case;
- packed-install failure;
- supported-agent integration failure;
- aggregate test timeout;
- Recall@5 below 0.90;
- unresolved harmful-context regression.

## Implementation checkpoints

After each milestone:

1. run the narrow tests named in the tasks;
2. run typecheck and the ordinary suite;
3. inspect the migration against a copied existing database when schema changed;
4. inspect `doctor --json` when queue behavior changed;
5. inspect Viewer when persisted response shapes changed;
6. make the listed focused commit before starting the next milestone.

Do not begin Viewer polish, paired trials, or new integrations while the bounded-runtime, provenance, compiler, or packed-install gates are red.
