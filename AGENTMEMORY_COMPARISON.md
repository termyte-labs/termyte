# Termyte vs AgentMemory: code-backed technical comparison

Date: 2026-07-01  
Repositories inspected:

- Termyte: commit `cd4e19a26c4ad95f22f414a447e11018fa6bfd26`
- AgentMemory: commit `93ae9bc04f3ab5042f982aaadf11f1e3f5137531` (`v0.9.27`)

## Executive verdict

**AgentMemory is the better product today for most users who want a mature, feature-rich, multi-client memory service. Termyte is the better foundation if the priority is a small, local, auditable coding-agent memory core with raw-event provenance and few moving parts.**

This is not a close feature contest. AgentMemory has roughly 39.6k lines under `src`, 129 test files, 53 MCP tools, 128 REST endpoints, many agent integrations, lifecycle management, graph retrieval, audit/governance functions, export/import, a viewer, provider fallbacks, and operational diagnostics. Termyte has roughly 6.2k source lines, 17 test files, five MCP tools, five relational data tables, and a focused capture/enrich/search pipeline.

If “better” means what a user should install now, **AgentMemory wins**. If “better” means which architecture is easier to understand, embed, independently evolve, and prove correct, **Termyte wins**. Termyte does not currently have enough differentiated capability or retrieval evidence to beat AgentMemory as a general product.

## Evidence and validation boundaries

### Termyte

- `npm run build`: passed.
- `npm test`: passed, 17 files and 136 tests.
- Direct SQLite schema, FTS triggers, observer stages, MCP server, integrations, and synthesis adapters were inspected.

### AgentMemory

- Static count: 129 test files and approximately 1,430 `it`/`test` declarations.
- `npm test` and `npm run build` could not run because the fresh checkout has no dependencies installed (`vitest` and `tsdown` were unavailable). Dependencies were not installed because this audit was read-only.
- The build script contains Unix-specific `cp`, `mkdir`, redirection, and `|| true`; it is not a clean Windows-native contributor workflow.
- Core registration, state schema, capture hooks, search indexes, vector persistence, REST/MCP routing, providers, lifecycle functions, auth, and tests were inspected.
- Benchmark claims were not credited as independently verified because their datasets and runs were not reproduced in this audit.

## What each product actually is

### Termyte

Termyte is an embedded/local memory pipeline for coding-agent activity:

1. Platform-specific hooks normalize raw agent events.
2. Every normalized event becomes an immutable SQLite trace.
3. An LLM or installed coding-agent CLI converts traces into observations.
4. Observations are consolidated into memories.
5. SQLite FTS5 and in-process cosine similarity retrieve memories through reciprocal-rank fusion.
6. A small stdio MCP server exposes search and inspection.

Its strongest design property is explicit provenance: `traces -> observations -> memories`, with source IDs preserved in the relational schema.

### AgentMemory

AgentMemory is a memory service/platform built around `iii-engine`:

1. Agent hooks send events to a local REST service.
2. Worker functions persist observations, sessions, summaries, memories, indexes, graphs, audit events, and lifecycle metadata through engine-managed KV state.
3. BM25, vector, graph, query-expansion, reranking, and filtering paths serve retrieval.
4. REST, MCP, hooks, skills, a viewer, export/import, team sharing, retention, governance, diagnostics, and many higher-order memory operations form a broad product surface.

Its strongest design property is breadth: it is already an ecosystem-facing service rather than only a memory library.

## Detailed comparison

| Dimension | Termyte | AgentMemory | Winner |
|---|---|---|---|
| Core architecture | Direct, single-process TypeScript + SQLite | Worker/function/trigger system over external `iii-engine` | Termyte for simplicity; AgentMemory for service extensibility |
| Raw capture | Dedicated immutable `traces` table and normalized platform adapters | Hook observations are persisted, but the model is centered on observations/memories rather than a minimal immutable event ledger | Termyte |
| Provenance | Relational source trace and source observation IDs | IDs and relations exist across KV scopes, graph, audit, replay, and memory types | Tie: Termyte is clearer; AgentMemory is richer |
| Memory formation | Explicit two-stage LLM pipeline; background synthesis can use installed Claude/Codex/Gemini/OpenCode CLIs | Zero-LLM synthetic compression by default; optional provider-backed compression, consolidation, reflection, semantic/procedural memories | AgentMemory |
| Retrieval | SQLite FTS5 + full-scan cosine + RRF + file overlap boost | BM25 + vector + optional graph stream + query expansion + reranking + filters + token budgets | AgentMemory |
| Vector scalability | Loads every embedded memory and scans it for each query | Also uses an in-memory linear vector index, but persists/shards it and has rebuild/dimension validation | AgentMemory, but neither is a true large-scale ANN design |
| Keyword indexing | SQLite FTS5 with transactionally maintained triggers | Custom in-memory BM25 with persisted snapshots and rebuild/backfill logic | Termyte for consistency; AgentMemory for search control |
| Storage integrity | SQLite WAL, foreign keys, indexes, transactions, FTS triggers | Engine-managed KV over file SQLite; application-level cross-scope consistency | Termyte |
| Crash/retry behavior | `processed_at` queues exist, but failed trace/consolidation work is deliberately marked processed and dropped | More operational recovery, persistence, diagnostics, and circuit-breaking; complexity creates more failure surfaces | AgentMemory operationally; Termyte's current retry semantics are weak |
| Integrations | Claude Code, Codex, Cursor, Gemini, Windsurf, OpenCode, plus MCP-only clients | Much wider connector/plugin/hook surface across Claude, Codex, Copilot, Cursor, Gemini, OpenCode and others | AgentMemory |
| MCP/API | Five read/search MCP tools; no network REST service | 53 MCP tools, resources/prompts, and 128 REST endpoints | AgentMemory |
| Lifecycle | Basic session end, observation consolidation, and summaries | Retention scoring, eviction, forgetting, consolidation, reflection, slots, snapshots, checkpoints, branch awareness, routines, lessons | AgentMemory |
| Governance/audit | No general audit log, permissions, retention policy, export/import, or deletion governance | Auth option, audit records, governance endpoints, retention and bulk deletion | AgentMemory |
| Offline mode | Local SQLite; embeddings can be local; synthesis can use installed agent CLI | Zero-LLM mode with BM25 and local embeddings; reduced standalone MCP fallback | Tie |
| Provider resilience | One OpenAI-compatible LLM provider in observer path; agent-CLI synthesis is separate | Multiple LLM and embedding providers, fallback chain, circuit breaker, dimension guards | AgentMemory |
| UI/operations | CLI only | Viewer, health endpoints, doctor/diagnostics, telemetry, Docker assets | AgentMemory |
| Test evidence in this audit | 136/136 passed | Large test corpus, but not executable in this checkout without installing dependencies | Termyte for verified result; AgentMemory for breadth |
| Windows development | Current build/test passed on Windows | npm build script is Unix-shell-oriented | Termyte |
| Maintainability | Small, cohesive, easy to audit | Very large files (`api.ts`, `cli.ts`, MCP server) and broad synchronization obligations | Termyte |
| Community/product maturity | Early `0.1.0`, small surface | `0.9.27`, many releases/contributors/integrations and large adoption signal | AgentMemory |

## Core memory quality

### Capture fidelity

Termyte has the cleaner evidence chain. Raw tool input/output is stored before enrichment. The enrichment result refers back to trace IDs, and consolidated memories refer to observation and trace IDs. This is valuable for debugging hallucinated or stale memory and for rebuilding derived layers.

AgentMemory captures much more contextual and lifecycle state, but its architecture quickly turns events into application-level observation objects distributed across KV scopes. It has replay, audit, relations, graph nodes, and richer metadata, but the core lineage is harder to reason about because behavior is spread over many registered functions.

**Verdict: Termyte is stronger as an event-sourced memory kernel; AgentMemory is stronger as a complete memory application.**

### Enrichment and consolidation

Termyte's two-stage pipeline is coherent but basic. It performs one LLM call per trace in the observer path, then batches observations into consolidated memories. There is no confidence model, conflict resolution, temporal decay, supersession policy, or robust retry queue.

AgentMemory implements more layers: synthetic compression, optional LLM compression, semantic/procedural consolidation, reflection, confidence/strength concepts, relations, graph extraction, retention, and explicit memory-management operations. Several are feature-flagged or provider-dependent, but they are executable paths rather than README-only claims.

**Verdict: AgentMemory materially wins.**

### Retrieval

Termyte's retrieval is correct and understandable for an MVP. FTS5 results and cosine results are merged using RRF. Repository/type/recency filters and current-file boosts are supported. However:

- Vector search reads all embedded memories and performs an O(n) scan per query.
- The optional `sqlite-vec` table is created but is not used by the retrieval path.
- Exact tokenization is simplistic: every whitespace token becomes a quoted FTS term, effectively favoring strict conjunctions.
- There is no reranker, query expansion, graph retrieval, access-based scoring, or evaluation harness in the Termyte repository.

AgentMemory uses a custom BM25 index and a linear vector index, then can add graph retrieval, query expansion, project/cwd/agent filters, formats, token budgets, and other ranking paths. It also handles embedding dimension mismatch and persisted index rebuilds. Its weakness is operational complexity: BM25/vector state is not transactionally coupled to primary KV writes, so backfill, debounce persistence, and rebuild logic are needed to repair drift.

**Verdict: AgentMemory wins capability and likely relevance; Termyte wins consistency and debuggability.**

## Reliability and data integrity

Termyte's SQLite model is its largest architectural advantage. WAL mode, foreign keys, table indexes, partial indexes for unprocessed rows, and FTS synchronization triggers provide understandable consistency.

However, Termyte's advertised crash-safety is incomplete:

- A Stage 1 exception in `processUnprocessedOnce()` marks the trace processed instead of retrying it.
- A consolidation exception marks the observation batch processed instead of retrying it.
- Embedding writes are fire-and-forget and errors are swallowed, with no persistent retry state.
- Inline queue errors are logged but have no dead-letter or failure metadata.

AgentMemory has significantly more failure handling: resilient providers, fallbacks, persistence retries, dimension checks, health/diagnostic paths, index rebuild/backfill, process cleanup, and scheduled maintenance. But its distributed-in-one-machine architecture has more partial-failure modes: engine availability, worker availability, REST hooks, asynchronous KV/index writes, persisted snapshots, and many independently maintained surfaces.

**Verdict: Termyte has the better storage primitive; AgentMemory has the better operational machinery. Neither has a clean end-to-end exactly-once guarantee.**

## Security and privacy

Neither product is a security boundary. Both capture sensitive tool inputs, outputs, prompts, file paths, and potentially source code.

Termyte is local and has no general network server, which reduces exposure. It also has no encryption at rest, field redaction, access control, audit trail, or retention/deletion policy framework.

AgentMemory exposes a large local REST surface. `AGENTMEMORY_SECRET` enables bearer authentication, but authentication is optional; when unset, `checkAuth()` allows requests. Localhost binding reduces exposure if the engine configuration remains local, but users should not expose the service without a secret and transport protection. AgentMemory does provide privacy/governance/audit functions and explicit deletion/retention tools, which Termyte lacks.

**Verdict: Termyte has the smaller attack surface; AgentMemory has more controls. For a networked/team deployment, AgentMemory needs deliberate hardening rather than default trust.**

## Maintainability and product risk

### Termyte risks

1. It is early and has no demonstrated retrieval benchmark.
2. The product is mostly a compact subset of capabilities AgentMemory already ships.
3. The observer and synthesis paths overlap conceptually and need a single clear production story.
4. Retry/dead-letter behavior is not production-grade.
5. The `sqlite-vec` integration is schema-only; retrieval still scans BLOBs.
6. There is no memory lifecycle, conflict resolution, confidence, retention, export/import, audit, or viewer.
7. Five MCP tools are insufficient for broad memory management.

### AgentMemory risks

1. It depends on `iii-engine`; the memory system is not a simple standalone library despite the local deployment story.
2. Breadth has produced very large coordination hotspots and duplicated registration surfaces.
3. Custom BM25/vector persistence can drift from primary KV state and requires repair logic.
4. Many advanced features make quality difficult to characterize as one coherent system.
5. The default unauthenticated local REST model is unsafe if users expose ports beyond localhost.
6. The full test suite excludes the integration test by default.
7. The source build script is Unix-oriented and failed immediately in this Windows checkout before compilation because dependencies were absent; after dependencies are installed, shell portability remains a likely issue.
8. A reduced standalone MCP fallback supports only a subset of the advertised tools, so behavior depends on whether the daemon is running.

## Scored assessment

Scores are relative product-engineering judgments based on the inspected commit, not scientific benchmark results.

| Category | Weight | Termyte | AgentMemory |
|---|---:|---:|---:|
| Capture/provenance | 15 | 13 | 12 |
| Memory formation/lifecycle | 20 | 8 | 17 |
| Retrieval capability | 20 | 10 | 17 |
| Reliability/data integrity | 15 | 10 | 11 |
| Integrations/operability | 15 | 7 | 14 |
| Maintainability/auditability | 10 | 9 | 5 |
| Security/privacy controls | 5 | 2 | 3 |
| **Total** | **100** | **59** | **79** |

## Final conclusion: which is better?

### For an end user choosing today

**Choose AgentMemory.** It is more capable, more integrated, more operationally mature, and much further along in memory lifecycle and retrieval. Termyte's smaller codebase does not compensate for the missing product features.

### For a developer choosing a foundation to own and modify

**Choose Termyte if you value direct SQLite ownership, raw trace provenance, Windows-friendly local development, and a codebase one engineer can fully understand.** Choose AgentMemory if adopting `iii-engine` and a large service surface is acceptable.

### For Termyte's strategy

Trying to match AgentMemory feature-for-feature is the wrong contest. AgentMemory is already far ahead on breadth. Termyte needs to win on a narrower, provable axis:

1. Make raw traces and deterministic lineage the core differentiator.
2. Implement durable retries, failure metadata, and replay from traces.
3. Actually use `sqlite-vec` or another indexed vector path.
4. Build a reproducible retrieval/e2e benchmark and publish raw results.
5. Add memory conflict/supersession, confidence, retention, and deletion without turning the codebase into a platform framework.
6. Prove low-friction agent-native synthesis using existing Claude/Codex/Gemini subscriptions.
7. Keep the local embedded architecture; do not copy AgentMemory's service breadth unless users require it.

Until those points are implemented and measured, **AgentMemory is objectively the stronger general-purpose agent memory product, while Termyte is a promising but substantially earlier and narrower implementation.**

## Second-pass critique of this audit

- AgentMemory was statically inspected but not executed because dependencies were absent. Its runtime score could move up if all 1,430 tests and integration tests pass on this machine, or down if engine/bootstrap behavior fails.
- Termyte's passing tests prove internal behavior, not real multi-session memory usefulness with live agents.
- Retrieval quality cannot be conclusively ranked without running the same corpus and queries through both products. AgentMemory wins here on implemented retrieval machinery, not on a reproduced head-to-head relevance result.
- GitHub stars, release count, and source size are adoption/scope signals, not correctness evidence.
- Some AgentMemory features are optional or disabled by default. The report credits them as implemented capabilities, not as default user behavior.
- Termyte's cleaner architecture may become a stronger product advantage at scale, but it is not currently enough to overcome the capability gap.
