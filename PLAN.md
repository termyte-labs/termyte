# Termyte Self-Correcting Memory Layer Plan

## Objective

Turn the current local-first capture, memory-construction, and retrieval prototype into a dependable self-correcting memory layer for coding agents.

Self-correction means observed downstream outcomes can be attributed to specific injected memories and can cause those memories to be reinforced, challenged, corrected, conflicted, superseded, or excluded from future retrieval.

## How to use this plan

Status values:

- `pending`: not started;
- `in_progress`: actively owned by one lead;
- `blocked`: requires a named external dependency or founder decision;
- `completed`: every acceptance criterion and validation step passed.

Before implementation, load the lead skill from `.agents/skills`. Load supporting skills only for explicit cross-domain interfaces. Update this file in the same change as task completion.

## Current baseline

- Typecheck: passing
- Tests: 279 passing across 40 files
- Build: passing from source checkout
- Component evaluation command: passing (leakage removed; honest non-inflated metrics)
- Package binaries: working — declared and emitted paths align; clean tarball install executes every binary
- Automatic memory processing after hook capture: implemented (detached, single-instance-locked worker spawned by the hook)
- Closed self-correction loop: not implemented

## Phase 0 — Restore a truthful, executable product

### PKG-001 — Fix package layout and binary entry points

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `evaluation-benchmarking-lead`
- **Depends on:** none
- **Problem:** `package.json` targets `dist/index.js` and `dist/cli/*`; TypeScript emits `dist/src/index.js` and `dist/src/cli/*`.
- **Deliverables:** align compiler layout or package entry paths; fix OpenCode built-plugin lookup; add packed-install validation.
- **Outcome:** set `tsconfig.json` `rootDir` to `src` so the flat `dist/cli/*`, `dist/index.js`, `dist/mcp/server.js`, and `dist/integrations/opencode-plugin/index.js` emit matches `package.json` and installer probes; added `test/packaging.test.ts` as a regression guard; verified with a clean temporary `npm pack` install that `termyte`, `termyte-hook`, and `termyte-worker` execute and the package imports.
- **Acceptance:** a clean temporary install of `npm pack` output can import the package and execute `termyte`, `termyte-hook`, and `termyte-worker`.
- **Validate:** typecheck, tests, build, `npm pack`, clean tarball install, execute every binary.

### DOC-001 — Remove false runtime and product claims

- **Status:** completed
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** none
- **Problem:** installer messages claim automatic synthesis that installed commands do not perform; older docs describe obsolete schemas and configuration.
- **Deliverables:** make installer output match executable behavior; audit remaining tracked documentation and CLI help.
- **Outcome:** replaced false "synthesis will run automatically" messages in the Claude Code, Codex, Gemini, and OpenCode installers with truthful capture/enqueue messages stating the worker is not run automatically; removed a dead `PLACEHOLDER_CONTEXT` constant that claimed context "will appear"; corrected the OpenCode plugin doc comment from "memories injected automatically" to a placeholder disclaimer; reworded `termyte synth` help from "background memory synthesis" to "generate observations from captured traces"; updated doc `dist/src` path references. Added `test/installer-claims.test.ts` asserting no installer emits forbidden automatic-processing claims and that the worker-not-automatic wording is present.
- **Acceptance:** repository-wide claim audit finds no automatic-processing, schema, packaging, or self-correction claim unsupported by a validated path.
- **Validate:** focused installer tests, generated-config inspection, documentation search, Tier 2 checks.

## Phase 1 — Make durable memory production automatic

### RUN-001 — Define and implement worker supervision

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** PKG-001
- **Problem:** hooks enqueue jobs but nothing installed guarantees queue execution.
- **Deliverables:** choose a low-friction cross-platform worker trigger/supervision model; ensure hooks remain non-blocking; expose worker ownership and shutdown behavior.
- **Outcome:** added `src/pipeline/worker-supervisor.ts` with a `DetachedWorkerSupervisor` that spawns `termyte-worker --until-idle --supervised` detached and unref'd from `termyte-hook` after every successful ingest, plus a single-instance lockfile (`<db>.worker.lock`) so redundant spawns exit immediately and a crashed worker's stale PID lock is taken over. The worker acquires/releases the lock around its run (`src/cli/worker.ts`). `TERMYTE_AUTO_WORKER=0` disables supervision; `TERMYTE_WORKER_PATH` overrides the worker binary. Installer messages and docs were updated to state the worker starts automatically. The hook is non-blocking (fire-and-forget spawn).
- **Acceptance:** after a supported agent hook records a trace, memory reaches active state without a manually invoked worker and without blocking the agent.
- **Validate:** built-package installation plus live or faithful platform smoke test, crash/restart test, latency measurement.

### RUN-002 — Complete durable job handlers

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-001
- **Problem:** `dedupe_memories` and `update_summary` are marked successful without doing work.
- **Deliverables:** implement handlers or remove unsupported job kinds; define idempotency and failure behavior.
- **Outcome:** implemented a real `dedupe_memories` handler (canonical-key computation, same-repo candidate comparison, winner selection, `markMemorySuperseded` + `memory_edges` row + soft-delete of the loser's document) and a real `update_summary` handler (session trace aggregation, summary prompt, parser, idempotent `upsertSummary` per session, `<skip_summary/>` no-op). Added a `default` case that dead-letters unsupported job kinds so no kind silently succeeds. Added store methods `updateMemoryCanonicalKey`, `markMemorySuperseded`, `insertMemoryEdge`, `getMemoryEdges`. Both handlers are idempotent (unique job subjects, unique edges, ON CONFLICT summary, early-return for already-superseded subjects).
- **Acceptance:** no declared job kind succeeds without performing its contract; retries cannot duplicate memories or summaries.
- **Validate:** focused job tests, fault injection, full pipeline integration test, Tier 2 checks.

### RUN-003 — Remove full-table completion scans

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** RUN-002
- **Problem:** trace and observation completion checks scan and parse every derived row.
- **Deliverables:** indexed provenance lookup or explicit completion accounting.
- **Outcome:** added indexed `trace_observations` and `observation_memories` link tables (populated idempotently at observation/memory insert in the pipeline, with a one-time JSON backfill in `runMigrations`). Rewrote `markTraceProcessedIfObservationsReady` and `markObservationProcessedIfMemoriesReady` to look up derived rows via these indexes, bounded by the subject's fan-out instead of a full-table scan. Added store helpers `insertTraceObservationLinks` / `insertObservationMemoryLinks`.
- **Acceptance:** completion work is bounded by the current trace/observation fan-out and remains correct under retries.
- **Validate:** query-plan inspection, large-corpus test, retry and concurrent-worker tests.

## Phase 2 — Make lifecycle state real

### MEM-001 — Execute deduplication in production

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `evaluation-benchmarking-lead`
- **Depends on:** RUN-002
- **Problem:** dedupe helpers and canonical keys exist but have no production caller.
- **Deliverables:** compute canonical keys; compare scoped candidates; choose winner; persist duplicate/supersession edge; update lifecycle and document state.
- **Outcome:** implemented by the `dedupe_memories` durable handler (RUN-002): computes/persists canonical keys, compares same-repo active candidates via `shouldDeduplicate` (exact canonical-key or high cosine + file overlap), chooses a winner with `chooseDuplicateWinner`, marks the loser `superseded` with `superseded_by` + a `memory_edges` row, and soft-deletes the loser's search document. Provenance columns are preserved. The loser is excluded from default retrieval by RET-001.
- **Acceptance:** equivalent memories converge idempotently; the loser cannot be returned by default retrieval; provenance is retained.
- **Validate:** exact, semantic, false-positive, retry, and concurrency cases.

### MEM-002 — Execute decay and staleness transitions

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `evaluation-benchmarking-lead`
- **Depends on:** RUN-001
- **Problem:** decay scoring exists only as a pure helper and evaluation example.
- **Deliverables:** scheduled lifecycle job; persist decayed score and state transition; define reinforcement behavior.
- **Outcome:** added `decay_memories` durable job (enqueued after each `embed_memory`). The handler computes `memoryDecayScore` for active memories, persists the score, and transitions to `stale` when below the 0.22 threshold. Superseded/deleted/stale memories are skipped. Added `reinforceMemory` store method (increments usage_count, updates last_accessed_at/last_reinforced_at, restores stale→active) and `updateMemoryDecayScore`. Idempotent: stale memories are not re-transitioned.
- **Acceptance:** old low-value memories become stale; reinforced memories recover according to explicit rules; runs are idempotent.
- **Validate:** time-controlled lifecycle tests and worker integration test.

### RET-001 — Enforce lifecycle eligibility in retrieval

- **Status:** completed
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** MEM-001, MEM-002
- **Problem:** stale, conflicted, superseded, deleted, and failed memories remain retrievable.
- **Deliverables:** central eligibility policy used by FTS, vector, recent-memory context, MCP, and CLI paths; explicit diagnostic override.
- **Outcome:** added `src/retrieval/eligibility.ts` (default eligible = `active`; `ALL_MEMORY_STATES` override). Applied it in `FTSSearch` (bound `lifecycle_state IN (...)` clause), `VectorSearch` (in-memory filter), `HybridSearch` (passthrough), `ContextBuilder` (no-query recent path filtered), and CLI `search`/`memories` via a new `--all-states` diagnostic flag. MCP search/context inherit filtering through HybridSearch/ContextBuilder. `insertMemory` now defaults new memories to `active` so directly-seeded and pipeline memories are eligible; the pipeline overrides to `awaiting_embedding` then `active`. (MEM-002's decay transitions are not yet implemented, but `stale` is already excluded by the policy.)
- **Acceptance:** default retrieval returns only eligible memory states across every entry point.
- **Validate:** state matrix across FTS, vector, context, MCP, CLI, and recent-memory retrieval.

### MEM-003 — Implement real summary generation

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-002
- **Problem:** summary jobs are queued but are no-ops.
- **Deliverables:** durable summary handler, prompt/parser contract, upsert semantics, provenance or session evidence.
- **Outcome:** implemented by the durable `update_summary` handler (RUN-002): aggregates a session's traces (user prompts, final response, files), calls the LLM with `buildSummaryPrompt`, parses via `parseAgentXml`, and upserts via `upsertSummary` (`ON CONFLICT(session_id)` keeps exactly one latest summary per session). `<skip_summary/>` and empty results write nothing; malformed XML dead-letters instead of fabricating. The job subject is unique per session and the upsert is idempotent, so retries cannot duplicate.
- **Acceptance:** session-end summary work survives interruption and produces one deterministic latest summary per session.
- **Validate:** malformed output, retry, upsert, session-end integration, Tier 2 checks.

## Phase 3 — Close the feedback loop

### CTX-001 — Persist context injections

- **Status:** completed
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** RET-001
- **Problem:** context tools return `contextInjectionId: null`, so later outcomes cannot be attributed.
- **Deliverables:** injection table/model; unique ID; selected memory IDs, scores, query, files, repository, session, timestamp, and surface.
- **Outcome:** added `context_injections` table (migration); `ContextBuilder.build()` now persists each injection (UUID, memory IDs, query, repo, session, files, surface) and returns `contextInjectionId`. MCP `context` and CLI `context` return the real ID; hook context handler passes `surface: "hook"` and `sessionId`.
- **Acceptance:** every injected memory set is durably identifiable and returned to the caller.
- **Validate:** CLI/MCP/hook injection tests, retry/idempotency tests, migration test.

### FB-001 — Record automatic exposure and usage signals

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** CTX-001
- **Problem:** feedback is only explicit MCP input; retrieval does not record `shown`, and usage is not attributable.
- **Deliverables:** record `shown`; define defensible `used` evidence; associate events with injection and downstream traces.
- **Outcome:** `ContextBuilder.build()` now records a `shown` feedback event for each injected memory, linked to the injection ID. The existing `recordMemoryFeedback` stores the event with `context_injection_id`; `used` events can be recorded explicitly via MCP `feedback` tool with the same injection ID. `shown` is automatic; `used` is explicit (defensible: the agent or user confirms the memory was actually referenced).
- **Acceptance:** exposure and usage events are persisted once per defined event and can be traced to source memories and agent actions.
- **Validate:** event-state tests, duplicate delivery, abandoned injection, multi-memory attribution cases.

### FB-002 — Feed lifecycle signals into ranking

- **Status:** in_progress
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `evaluation-benchmarking-lead`
- **Depends on:** FB-001, MEM-002
- **Problem:** importance, confidence, usage, decay, and feedback do not affect ranking.
- **Deliverables:** transparent scoring features or reranking stage; diagnostic score breakdown; conservative defaults.
- **Implemented evidence:** added a transparent `RetrievalScoreBreakdown` and bounded 0.75–1.25 multiplier over RRF using confidence, importance, decay, bounded usage, and explicit feedback. Automatic `shown` events no longer mutate importance and are excluded from ranking aggregates. Production CLI, hook, MCP, SDK, eval, and benchmark constructors consume the feedback store. Context injection items persist the complete score breakdown. Focused positive, negative, cap, exposure-loop, reranking, and persistence tests pass. The existing independent retrieval regression reports Recall@5 0.80 but still fails 4/20 cases, so weight calibration and latency/harm evaluation remain open.
- **Acceptance:** controlled fixtures demonstrate useful reinforcement and harmful-memory suppression without unacceptable recall loss.
- **Validate:** independent positive/negative corpus, score-breakdown tests, latency benchmark.

### COR-001 — Create verification and correction jobs

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `code-intelligence-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** FB-001
- **Problem:** `corrected` feedback only lowers confidence; no replacement knowledge is produced.
- **Deliverables:** durable verification job; gather source and current repository evidence; decide reinforce, conflict, correct, or supersede; preserve audit trail.
- **Outcome:** added `verify_memory` durable job. When `corrected` feedback is recorded with `correctionText`, `recordMemoryFeedback` auto-enqueues a `verify_memory` job; the handler creates a grounded replacement memory (from the correction text), embeds it, inserts a `supersedes` edge, soft-deletes the old document, and marks the old memory superseded. When no correction text is provided, the memory is marked `conflicted` and excluded from default retrieval. Added `correction_text` column to `memory_feedback` (migration) and `correctionText` parameter to MCP feedback tool. Idempotent: already-superseded memories short-circuit.
- **Acceptance:** a correction event can create a grounded replacement, link it to the original, and prevent the invalid memory from default retrieval.
- **Validate:** correction, insufficient-evidence, conflicting-evidence, retry, and provenance tests.

### COR-002 — Implement memory edges and explainability

- **Status:** completed
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`
- **Depends on:** MEM-001, COR-001
- **Problem:** `memory_edges` exists without runtime writers and `termyte.explain` returns placeholders.
- **Deliverables:** edge CRUD and invariants; populated explain output with traces, observations, edges, feedback, state, and timestamps.
- **Outcome:** added shared explainability plumbing in `src/explain/memory-explain.ts` that resolves memory provenance, source observations, source traces, edges, feedback, and missing deleted-source references; added `Store.getObservationsByIds()` and `Store.getMemoryFeedbackForMemory()`; wired `termyte.explain` in MCP and a new `termyte explain <id>` CLI command to the shared builder; added regression tests for lineage rendering, missing provenance, and CLI JSON output.
- **Acceptance:** any active, conflicted, or superseded memory can explain its origin and lifecycle history.
- **Validate:** graph invariant tests, MCP explain contract, deleted-source behavior.

## Phase 4 — Improve code applicability

### CODE-001 — Normalize code evidence and repository scope

- **Status:** completed
- **Lead:** `code-intelligence-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-001
- **Problem:** file extraction and path comparison are heuristic and inconsistent across agents/platforms.
- **Deliverables:** canonical repository-relative paths; explicit read/modified semantics; normalized commands, tests, and stack evidence.
- **Acceptance:** equivalent Windows/POSIX paths and supported adapter payloads resolve to stable evidence without cross-repo leakage.
- **Validate:** adapter matrix, monorepo, symlink, generated-file, and case-sensitivity fixtures.

### CODE-002 — Add applicability evidence to correction and retrieval

- **Status:** in_progress
- **Lead:** `code-intelligence-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `retrieval-search-ranking-lead`
- **Depends on:** CODE-001, COR-001
- **Problem:** similarity and filenames are insufficient to determine whether an old fix still applies.
- **Implemented evidence:** added persisted `applicability_json` on memories, populated from observation files/commands and preserved across correction replacements; surfaced applicability evidence in explain/context rendering; extended retrieval scoring with a bounded applicability adjustment based on matching evidence files and commands; added regression tests proving the applicability-adjusted memory ranks above an otherwise similar candidate and that the score breakdown exposes the new signal.
- **Implemented evidence:** added persisted `applicability_json` on memories, populated from observation files/commands and preserved across correction replacements; surfaced applicability evidence in explain/context rendering; extended retrieval scoring with a bounded applicability adjustment based on matching evidence files and commands; added regression tests proving the applicability-adjusted memory ranks above an otherwise similar candidate, prefers the applicable memory over same-text stale context, and exposes the new signal in the score breakdown.
- **Deliverables:** versioned dependency, test, stack-frame, diff, and optional symbol evidence; applicability contract consumed by verification and ranking.
- **Acceptance:** stale same-text/different-root-cause cases are suppressed while same-subsystem relevant cases are retained.
- **Validate:** independently labeled applicability corpus and ablation results.

## Phase 5 — Replace self-confirming evaluations

### EVAL-001 — Remove retrieval evaluation leakage

- **Status:** completed
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `retrieval-search-ranking-lead`
- **Depends on:** none
- **Problem:** expected keywords and queries are appended to indexed candidates, and expected keywords replace user queries.
- **Deliverables:** immutable candidates; natural queries; independently labeled relevance judgments; negative and stale cases.
- **Outcome:** removed two leakage paths in `seedCorpus` (no longer appends `"Eval keywords:"`/`"Eval queries:"` markers or expected keywords/queries to document content) and `runRetrievalEval` (uses natural `query.query` instead of `expectedKeywords.join(" ")` as the retrieval query). Removed inflated thresholds (0.85/0.70/0.50) that were only achievable through leakage; the suite now reports raw metrics and per-case failures for honest review. Added a leakage guard test asserting no document contains the answer-key markers. The non-leaked baseline with the character-hash test embedder is recall ~0.30 — this reflects the embedder, not production quality.
- **Acceptance:** evaluation never indexes answer-key fields and reports per-case failures plus aggregate metrics.
- **Validate:** leakage guard tests, corpus review, baseline comparison.

### EVAL-002 — Test the real installed pipeline

- **Status:** completed
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`, `memory-modeling-knowledge-architecture-lead`
- **Depends on:** PKG-001, RUN-001, RUN-002
- **Problem:** current component evals do not prove installed trace-to-memory behavior.
- **Implemented evidence:** added `test/installed-pipeline.test.ts`, a packed-install harness that builds the repo, packs the tarball, installs that tarball into an isolated temp project, executes the installed `doctor`, `hook`, `worker`, and `context` entry points, injects a fake-LLM failure on the first worker pass, waits for queue backoff, and verifies recovery on the second pass plus context retrieval from the installed package.
- **Deliverables:** clean-install harness; representative hook payload; worker execution; memory retrieval; interruption and retry scenarios.
- **Acceptance:** packed installation completes capture to retrievable memory and recovers from injected failure.
- **Validate:** isolated filesystem/process test on supported operating systems.

### EVAL-003 — Measure self-correction outcomes

- **Status:** in progress
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** all founding skills at their owned interfaces
- **Depends on:** FB-002, COR-001, CODE-002
- **Problem:** no experiment proves that memory or correction improves agent execution.
- **Deliverables:** paired baseline/memory/correction trials; frozen repos; randomized order; fresh sessions; deterministic task tests; harm metrics.
- **Acceptance:** report sample size, raw failures, median and spread for completion, cost, latency, retries, unrelated edits, wrong-memory use, and correction success.
- **Implemented evidence:** added `runCorrectionEval()` to the eval harness with deterministic replacement-memory and conflict paths, wired `correction` into CLI parsing, and covered the suite in `test/eval/harness.test.ts`.
- **Validate:** reproducibility rerun and blinded review of residual quality.

## Phase 6 — Security and operational readiness

### SEC-001 — Redact sensitive data before persistence and LLM calls

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `code-intelligence-lead`, `evaluation-benchmarking-lead`
- **Depends on:** none
- **Problem:** raw prompts, commands, inputs, and outputs may contain credentials or secrets.
- **Deliverables:** deterministic redaction pipeline; configurable allow/deny rules; redaction metadata; safe failure behavior.
- **Outcome:** added a deterministic recursive redaction layer in `src/security/redaction.ts`; `Store.insertTrace()` now redacts and persists trace payloads plus `redaction_json` metadata before they hit SQLite; observer and synthesis prompt builders now sanitize tool inputs, tool outputs, user prompts, and final responses before external LLM calls; added adversarial tests for recursive secrets, JWT/bearer/API key/url-credential/private-key formats, and prompt sanitization.
- **Acceptance:** known secret formats never appear in persisted traces, prompts sent to external LLMs, logs, or rendered context.
- **Validate:** adversarial secret corpus, encoded/multiline variants, false-positive review.

### OPS-001 — Make health and dead-letter recovery actionable

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `evaluation-benchmarking-lead`
- **Depends on:** RUN-002
- **Problem:** MCP health returns placeholders; viewer exposes state but no recovery workflow.
- **Deliverables:** real health metrics; queue age and failure counts; dead-letter inspect/retry command; structured diagnostics.
- **Outcome:** MCP `termyte.health` now returns real queue stats (pending/leased/succeeded/failed/dead), oldest pending age, and top-10 dead letters with error details. MCP `termyte.stats` returns real document counts and queue stats. Added CLI commands: `termyte health` (structured diagnostics), `termyte dead-letters` (list dead jobs), `termyte retry <jobId>` (reset dead job to pending), `termyte dismiss <jobId>` (remove dead job). Added store methods `getDeadJobs`, `retryDeadJob`, `dismissDeadJob`, `getHealthDiagnostics`.
- **Acceptance:** operators can identify and safely retry or dismiss failed work without direct SQL.
- **Validate:** degraded database, failed embedding, invalid LLM output, expired lease, and dead-letter scenarios.

### OPS-002 — Validate scale and concurrency limits

- **Status:** in_progress
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`, `retrieval-search-ranking-lead`
- **Depends on:** RUN-003, RET-001
- **Problem:** lifecycle completion and filtered vector retrieval have not been validated at production corpus sizes.
- **Implemented evidence:** active memory retrieval now writes and queries dimension-specific sqlite-vec cosine indexes, lazily backfills legacy embedding BLOBs, and falls back to the existing in-memory cosine scan when the native extension or index operation is unavailable. Direct sqlite-vec and retrieval/lifecycle tests pass. Added a queue-concurrency regression that leases 50 jobs across two workers on one database without duplicate claims or stale pending state. Benchmark reporting now surfaces query latency p50/p95/p99 alongside RSS resource usage, which makes the existing benchmark artifact bundle closer to the documented scale-and-concurrency evidence.
- **Deliverables:** benchmark corpus sizes; latency/memory thresholds; concurrent worker tests; decision on wiring sqlite-vec or retaining bounded scans.
- **Acceptance:** documented supported limits and no duplicate/corrupt state under expected worker concurrency.
- **Validate:** repeatable performance suite with p50/p95/p99 and memory usage.

## Phase 7 — Live agent integration proof

### INT-001 — Prove each supported adapter live

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `evaluation-benchmarking-lead`
- **Depends on:** PKG-001, RUN-001, CTX-001
- **Problem:** generated configuration tests do not prove current agent compatibility.
- **Deliverables:** versioned compatibility matrix and live smoke procedure for each advertised agent.
- **Acceptance:** capture, context injection, background processing, and error behavior are verified on every advertised supported surface; unsupported capabilities are stated explicitly.
- **Validate:** recorded live smoke logs with secrets removed.

## Exit criteria: credible self-correcting MVP

Termyte may call itself a self-correcting memory layer only when:

1. a clean packaged installation captures and processes traces automatically;
2. every injected memory is attributable through a durable injection ID;
3. downstream evidence produces feedback without relying only on manual MCP calls;
4. feedback changes future retrieval through explicit, tested policy;
5. incorrect knowledge can be verified, conflicted, corrected, and superseded with provenance;
6. invalid states are excluded from default retrieval;
7. independent evaluations show reduced repeated failures without increased harmful anchoring;
8. sensitive information is redacted before storage and external model calls;
9. at least one live coding-agent integration passes the full loop repeatedly;
10. README claims match built and observed behavior.

## Six-week implementation program

### EVAL-004 — Establish the zero-paid benchmark runtime

- **Status:** in_progress
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `retrieval-search-ranking-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** EVAL-001
- **Implemented evidence:** added `MemoryBenchmarkAdapter`, immutable dataset validation, answer-key leakage guards, isolated LongMemEval-S normalization, deterministic seeded scale generation, grep control, Termyte FTS and real local hybrid adapters, a real pipeline adapter that drives documents through `MemoryPipeline` using the deterministic offline LLM, a raw-session dataset loader that converts session turns into pipeline-friendly benchmark documents, a benchmark comparison report path that reads prior run artifacts and ranks them in Markdown/JSON, multi-adapter runs, Recall/Precision/MRR/NDCG/abstention/harm/latency metrics, dataset SHA-256 manifests, query/failure NDJSON, resource usage, Markdown reports, runnable `pipeline` and raw-session benchmark paths, and the built `termyte bench run` / `termyte bench compare` commands. Focused benchmark and retrieval tests, the full 304-test suite, typecheck, build, and built local-hybrid smoke pass with `sqlite_vec_active: 1`.
- **Remaining:** LoCoMo/MemoryAgentBench loaders, AgentMemory/Mem0/claude-mem adapters, and full public-dataset result runs. The Termyte adapter now uses active sqlite-vec retrieval when available.
- **Acceptance:** all approved public retrieval suites and scale tiers run without paid models and emit reproducible artifacts with normalized competitor baselines.

### RUN-004 — Make recurring durable jobs recur safely

- **Status:** completed
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** RUN-002
- **Outcome:** added `jobs.dedupe_key` and migrated the old permanent `(kind, subject_type, subject_id)` uniqueness constraint without losing existing job state. Summary jobs key each run to a trace watermark; decay jobs key each run to a UTC day. Identical runs remain idempotent while later runs for the same subject can execute.
- **Acceptance:** focused queue regression tests, full suite, typecheck, and build pass.

### CTX-002 — Persist normalized ranked injection items

- **Status:** completed
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `agent-runtime-execution-systems-lead`, `evaluation-benchmarking-lead`
- **Depends on:** CTX-001
- **Outcome:** added `context_injection_items` with rank, combined score, FTS/vector ranks, and rendered text. `ContextBuilder` preserves ranked results, and file-context routes through it with repository/session attribution instead of bypassing injection tracking.
- **Acceptance:** focused context and handler tests prove persisted file-context injections; full suite, typecheck, and build pass.

