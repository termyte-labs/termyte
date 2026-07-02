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
- Tests: 194 passing across 27 files
- Build: passing from source checkout
- Component evaluation command: passing, but retrieval results are contaminated and not product evidence
- Package binaries: broken because declared and emitted paths differ
- Automatic memory processing after hook capture: not implemented
- Closed self-correction loop: not implemented

## Phase 0 — Restore a truthful, executable product

### PKG-001 — Fix package layout and binary entry points

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `evaluation-benchmarking-lead`
- **Depends on:** none
- **Problem:** `package.json` targets `dist/index.js` and `dist/cli/*`; TypeScript emits `dist/src/index.js` and `dist/src/cli/*`.
- **Deliverables:** align compiler layout or package entry paths; fix OpenCode built-plugin lookup; add packed-install validation.
- **Acceptance:** a clean temporary install of `npm pack` output can import the package and execute `termyte`, `termyte-hook`, and `termyte-worker`.
- **Validate:** typecheck, tests, build, `npm pack`, clean tarball install, execute every binary.

### DOC-001 — Remove false runtime and product claims

- **Status:** pending
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** none
- **Problem:** installer messages claim automatic synthesis that installed commands do not perform; older docs describe obsolete schemas and configuration.
- **Deliverables:** make installer output match executable behavior; audit remaining tracked documentation and CLI help.
- **Acceptance:** repository-wide claim audit finds no automatic-processing, schema, packaging, or self-correction claim unsupported by a validated path.
- **Validate:** focused installer tests, generated-config inspection, documentation search, Tier 2 checks.

## Phase 1 — Make durable memory production automatic

### RUN-001 — Define and implement worker supervision

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** PKG-001
- **Problem:** hooks enqueue jobs but nothing installed guarantees queue execution.
- **Deliverables:** choose a low-friction cross-platform worker trigger/supervision model; ensure hooks remain non-blocking; expose worker ownership and shutdown behavior.
- **Acceptance:** after a supported agent hook records a trace, memory reaches active state without a manually invoked worker and without blocking the agent.
- **Validate:** built-package installation plus live or faithful platform smoke test, crash/restart test, latency measurement.

### RUN-002 — Complete durable job handlers

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-001
- **Problem:** `dedupe_memories` and `update_summary` are marked successful without doing work.
- **Deliverables:** implement handlers or remove unsupported job kinds; define idempotency and failure behavior.
- **Acceptance:** no declared job kind succeeds without performing its contract; retries cannot duplicate memories or summaries.
- **Validate:** focused job tests, fault injection, full pipeline integration test, Tier 2 checks.

### RUN-003 — Remove full-table completion scans

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** RUN-002
- **Problem:** trace and observation completion checks scan and parse every derived row.
- **Deliverables:** indexed provenance lookup or explicit completion accounting.
- **Acceptance:** completion work is bounded by the current trace/observation fan-out and remains correct under retries.
- **Validate:** query-plan inspection, large-corpus test, retry and concurrent-worker tests.

## Phase 2 — Make lifecycle state real

### MEM-001 — Execute deduplication in production

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `evaluation-benchmarking-lead`
- **Depends on:** RUN-002
- **Problem:** dedupe helpers and canonical keys exist but have no production caller.
- **Deliverables:** compute canonical keys; compare scoped candidates; choose winner; persist duplicate/supersession edge; update lifecycle and document state.
- **Acceptance:** equivalent memories converge idempotently; the loser cannot be returned by default retrieval; provenance is retained.
- **Validate:** exact, semantic, false-positive, retry, and concurrency cases.

### MEM-002 — Execute decay and staleness transitions

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `evaluation-benchmarking-lead`
- **Depends on:** RUN-001
- **Problem:** decay scoring exists only as a pure helper and evaluation example.
- **Deliverables:** scheduled lifecycle job; persist decayed score and state transition; define reinforcement behavior.
- **Acceptance:** old low-value memories become stale; reinforced memories recover according to explicit rules; runs are idempotent.
- **Validate:** time-controlled lifecycle tests and worker integration test.

### RET-001 — Enforce lifecycle eligibility in retrieval

- **Status:** pending
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`
- **Depends on:** MEM-001, MEM-002
- **Problem:** stale, conflicted, superseded, deleted, and failed memories remain retrievable.
- **Deliverables:** central eligibility policy used by FTS, vector, recent-memory context, MCP, and CLI paths; explicit diagnostic override.
- **Acceptance:** default retrieval returns only eligible memory states across every entry point.
- **Validate:** state matrix across FTS, vector, context, MCP, CLI, and recent-memory retrieval.

### MEM-003 — Implement real summary generation

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-002
- **Problem:** summary jobs are queued but are no-ops.
- **Deliverables:** durable summary handler, prompt/parser contract, upsert semantics, provenance or session evidence.
- **Acceptance:** session-end summary work survives interruption and produces one deterministic latest summary per session.
- **Validate:** malformed output, retry, upsert, session-end integration, Tier 2 checks.

## Phase 3 — Close the feedback loop

### CTX-001 — Persist context injections

- **Status:** pending
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** RET-001
- **Problem:** context tools return `contextInjectionId: null`, so later outcomes cannot be attributed.
- **Deliverables:** injection table/model; unique ID; selected memory IDs, scores, query, files, repository, session, timestamp, and surface.
- **Acceptance:** every injected memory set is durably identifiable and returned to the caller.
- **Validate:** CLI/MCP/hook injection tests, retry/idempotency tests, migration test.

### FB-001 — Record automatic exposure and usage signals

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** CTX-001
- **Problem:** feedback is only explicit MCP input; retrieval does not record `shown`, and usage is not attributable.
- **Deliverables:** record `shown`; define defensible `used` evidence; associate events with injection and downstream traces.
- **Acceptance:** exposure and usage events are persisted once per defined event and can be traced to source memories and agent actions.
- **Validate:** event-state tests, duplicate delivery, abandoned injection, multi-memory attribution cases.

### FB-002 — Feed lifecycle signals into ranking

- **Status:** pending
- **Lead:** `retrieval-search-ranking-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `evaluation-benchmarking-lead`
- **Depends on:** FB-001, MEM-002
- **Problem:** importance, confidence, usage, decay, and feedback do not affect ranking.
- **Deliverables:** transparent scoring features or reranking stage; diagnostic score breakdown; conservative defaults.
- **Acceptance:** controlled fixtures demonstrate useful reinforcement and harmful-memory suppression without unacceptable recall loss.
- **Validate:** independent positive/negative corpus, score-breakdown tests, latency benchmark.

### COR-001 — Create verification and correction jobs

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `code-intelligence-lead`, `agent-runtime-execution-systems-lead`
- **Depends on:** FB-001
- **Problem:** `corrected` feedback only lowers confidence; no replacement knowledge is produced.
- **Deliverables:** durable verification job; gather source and current repository evidence; decide reinforce, conflict, correct, or supersede; preserve audit trail.
- **Acceptance:** a correction event can create a grounded replacement, link it to the original, and prevent the invalid memory from default retrieval.
- **Validate:** correction, insufficient-evidence, conflicting-evidence, retry, and provenance tests.

### COR-002 — Implement memory edges and explainability

- **Status:** pending
- **Lead:** `memory-modeling-knowledge-architecture-lead`
- **Support:** `retrieval-search-ranking-lead`
- **Depends on:** MEM-001, COR-001
- **Problem:** `memory_edges` exists without runtime writers and `termyte.explain` returns placeholders.
- **Deliverables:** edge CRUD and invariants; populated explain output with traces, observations, edges, feedback, state, and timestamps.
- **Acceptance:** any active, conflicted, or superseded memory can explain its origin and lifecycle history.
- **Validate:** graph invariant tests, MCP explain contract, deleted-source behavior.

## Phase 4 — Improve code applicability

### CODE-001 — Normalize code evidence and repository scope

- **Status:** pending
- **Lead:** `code-intelligence-lead`
- **Support:** `agent-runtime-execution-systems-lead`
- **Depends on:** RUN-001
- **Problem:** file extraction and path comparison are heuristic and inconsistent across agents/platforms.
- **Deliverables:** canonical repository-relative paths; explicit read/modified semantics; normalized commands, tests, and stack evidence.
- **Acceptance:** equivalent Windows/POSIX paths and supported adapter payloads resolve to stable evidence without cross-repo leakage.
- **Validate:** adapter matrix, monorepo, symlink, generated-file, and case-sensitivity fixtures.

### CODE-002 — Add applicability evidence to correction and retrieval

- **Status:** pending
- **Lead:** `code-intelligence-lead`
- **Support:** `memory-modeling-knowledge-architecture-lead`, `retrieval-search-ranking-lead`
- **Depends on:** CODE-001, COR-001
- **Problem:** similarity and filenames are insufficient to determine whether an old fix still applies.
- **Deliverables:** versioned dependency, test, stack-frame, diff, and optional symbol evidence; applicability contract consumed by verification and ranking.
- **Acceptance:** stale same-text/different-root-cause cases are suppressed while same-subsystem relevant cases are retained.
- **Validate:** independently labeled applicability corpus and ablation results.

## Phase 5 — Replace self-confirming evaluations

### EVAL-001 — Remove retrieval evaluation leakage

- **Status:** pending
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `retrieval-search-ranking-lead`
- **Depends on:** none
- **Problem:** expected keywords and queries are appended to indexed candidates, and expected keywords replace user queries.
- **Deliverables:** immutable candidates; natural queries; independently labeled relevance judgments; negative and stale cases.
- **Acceptance:** evaluation never indexes answer-key fields and reports per-case failures plus aggregate metrics.
- **Validate:** leakage guard tests, corpus review, baseline comparison.

### EVAL-002 — Test the real installed pipeline

- **Status:** pending
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`, `memory-modeling-knowledge-architecture-lead`
- **Depends on:** PKG-001, RUN-001, RUN-002
- **Problem:** current component evals do not prove installed trace-to-memory behavior.
- **Deliverables:** clean-install harness; representative hook payload; worker execution; memory retrieval; interruption and retry scenarios.
- **Acceptance:** packed installation completes capture to retrievable memory and recovers from injected failure.
- **Validate:** isolated filesystem/process test on supported operating systems.

### EVAL-003 — Measure self-correction outcomes

- **Status:** pending
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** all founding skills at their owned interfaces
- **Depends on:** FB-002, COR-001, CODE-002
- **Problem:** no experiment proves that memory or correction improves agent execution.
- **Deliverables:** paired baseline/memory/correction trials; frozen repos; randomized order; fresh sessions; deterministic task tests; harm metrics.
- **Acceptance:** report sample size, raw failures, median and spread for completion, cost, latency, retries, unrelated edits, wrong-memory use, and correction success.
- **Validate:** reproducibility rerun and blinded review of residual quality.

## Phase 6 — Security and operational readiness

### SEC-001 — Redact sensitive data before persistence and LLM calls

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `code-intelligence-lead`, `evaluation-benchmarking-lead`
- **Depends on:** none
- **Problem:** raw prompts, commands, inputs, and outputs may contain credentials or secrets.
- **Deliverables:** deterministic redaction pipeline; configurable allow/deny rules; redaction metadata; safe failure behavior.
- **Acceptance:** known secret formats never appear in persisted traces, prompts sent to external LLMs, logs, or rendered context.
- **Validate:** adversarial secret corpus, encoded/multiline variants, false-positive review.

### OPS-001 — Make health and dead-letter recovery actionable

- **Status:** pending
- **Lead:** `agent-runtime-execution-systems-lead`
- **Support:** `evaluation-benchmarking-lead`
- **Depends on:** RUN-002
- **Problem:** MCP health returns placeholders; viewer exposes state but no recovery workflow.
- **Deliverables:** real health metrics; queue age and failure counts; dead-letter inspect/retry command; structured diagnostics.
- **Acceptance:** operators can identify and safely retry or dismiss failed work without direct SQL.
- **Validate:** degraded database, failed embedding, invalid LLM output, expired lease, and dead-letter scenarios.

### OPS-002 — Validate scale and concurrency limits

- **Status:** pending
- **Lead:** `evaluation-benchmarking-lead`
- **Support:** `agent-runtime-execution-systems-lead`, `retrieval-search-ranking-lead`
- **Depends on:** RUN-003, RET-001
- **Problem:** active vector retrieval scans embedding BLOBs and lifecycle completion has not been tested at production corpus sizes.
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
