# Termyte vs Claude-Mem: code-backed technical comparison

Date: 2026-07-01  
Repositories inspected:

- Termyte: `C:\Users\Palguna\Desktop\termyte`, commit `cd4e19a26c4ad95f22f414a447e11018fa6bfd26`
- Claude-Mem: `C:\Users\Palguna\Desktop\claude-mem`, commit `87e4836a86909bbfd056777a37546db443f90868`, version `13.8.0`

## Executive verdict

**Claude-Mem is the better product today. Termyte is the smaller and cleaner memory kernel, but it is not yet competitive with Claude-Mem on reliability, retrieval, integrations, operational tooling, or proven implementation depth.**

Claude-Mem contains about 67.8k source lines across 326 files, 190 test files, and approximately 2,116 statically identified test cases. It implements a persistent worker, durable message queue, SQLite and Chroma retrieval, multiple provider paths, hooks for several coding agents, an HTTP API, MCP tools, a viewer, transcript ingestion, privacy handling, supervision, telemetry controls, and a separate server architecture using Redis/Postgres.

Termyte contains about 6.2k source lines, 17 test files, and 136 tests. It implements a direct SQLite pipeline with explicit raw traces, observations, consolidated memories, FTS5, vector search, hooks, synthesis through installed agent CLIs, and five MCP tools.

Claude-Mem wins for users. Termyte wins only where a compact, directly owned SQLite architecture and immutable raw-event provenance matter more than product completeness.

## Validation boundaries

### Termyte

- `npm test`: **passed, 136/136 tests across 17 files**.
- The same checkout previously passed `npm run build`; the current comparison did not modify source code.
- Core schema, observer, synthesis, search, hooks, MCP, and installers were inspected.

### Claude-Mem

- Static inventory: about 67,764 source lines, 190 test files, and approximately 2,116 test declarations.
- `bun test`: could not start because Bun is not installed on this machine.
- `npm run build`: stopped because the fresh checkout has no installed `esbuild` dependency.
- `npm run typecheck:root`: stopped because `tsc` is unavailable in the checkout.
- No dependencies were installed because this audit was read-only.
- The local plugin/worker path and the newer server path were inspected separately.
- Test count and repository size are breadth signals, not passing-runtime evidence.

## What the products actually are

### Termyte

Termyte is a local memory pipeline:

1. Agent-specific hooks normalize events.
2. Every event is persisted as an immutable SQLite trace.
3. An LLM or installed coding-agent CLI turns traces into observations.
4. Observations are consolidated into memories.
5. SQLite FTS5 and in-process cosine search retrieve memories using reciprocal-rank fusion.
6. A small stdio MCP server exposes search and inspection.

The architecture is direct: the process owns SQLite, the schema has five principal tables, and derived memories retain trace and observation IDs.

### Claude-Mem

Claude-Mem is now two related systems:

1. **Local plugin/worker:** hooks send events to a Bun worker on localhost; a durable SQLite queue feeds Claude Agent SDK or other providers; generated observations and summaries are stored in SQLite and synchronized to Chroma; HTTP, MCP, context injection, and a viewer expose the data.
2. **Server path:** API-key-authenticated ingestion stores projects, sessions, agent events, memory items, sources, and audit records in SQLite or Postgres; BullMQ/Redis handles generation jobs.

The local path is the mature personal coding-agent product. The server path is a more ambitious multi-user architecture with stronger identity, provenance, jobs, and audit semantics, but also much greater operational complexity.

## Detailed comparison

| Dimension | Termyte | Claude-Mem | Winner |
|---|---|---|---|
| Core architecture | Direct Node/TypeScript + SQLite | Bun worker + SQLite + Chroma, plus optional Redis/Postgres server stack | Termyte for simplicity; Claude-Mem for capability |
| Raw event capture | Dedicated immutable `traces` table | Local raw tool payloads live in `pending_messages` until processed; server path has durable `agent_events` | Termyte for local provenance |
| Derived model | Traces → observations → memories → summaries | Local observations + session summaries; server agent events → memory items + sources | Tie conceptually; Termyte is clearer locally |
| Durable work queue | `processed_at` flags on traces/observations | Persistent `pending_messages` with status, unique tool IDs, buffering, claim handling, retry/restart logic | Claude-Mem |
| Failure behavior | Several failures are marked processed and not retried | Empty/provider failures generally leave or requeue work; supervisor and health logic exist | Claude-Mem |
| Enrichment | Simple two-stage XML pipeline; agent CLI synthesis | Stateful Agent SDK conversation, Claude/Gemini/OpenAI-compatible/OpenRouter providers, response processing and recovery | Claude-Mem |
| Keyword retrieval | SQLite FTS5 with synchronized triggers | SQLite FTS5 with triggers, structured filters, LIKE fallback | Claude-Mem slightly |
| Semantic retrieval | Full in-process scan of embedding BLOBs | Chroma vector database with SQLite hydration and sync state | Claude-Mem |
| Hybrid retrieval | True FTS/vector RRF | Metadata-first/Chroma ranking and strategy orchestration; not a classical weighted lexical-vector fusion in the inspected local strategy | Depends: Termyte algorithm is cleaner; Claude-Mem infrastructure is stronger |
| Search filters | Repo, type, recency, current files | Project, platform, type, concept, file, date, sessions, prompts, timelines | Claude-Mem |
| Context injection | MCP/context commands and installer hooks | Automatic context generation/injection, configurable rendering, token calculation, agent/human formats | Claude-Mem |
| MCP surface | Five tools | Roughly 20 tools including search, timeline, observations, memory, smart code search, corpora | Claude-Mem |
| Agent integrations | Claude, Codex, Cursor, Gemini, Windsurf, OpenCode, MCP clients | Claude, Codex, Cursor, Gemini, Windsurf, OpenCode, OpenClaw, MCP clients, transcript watchers | Claude-Mem |
| UI and operations | CLI only | Viewer, SSE, logs, settings, health monitoring, doctor/install flows, supervisor | Claude-Mem |
| Privacy | Local-only surface; no formal private-content protocol | Privacy-stripping validation, environment sanitization, telemetry consent/redaction | Claude-Mem |
| Team/server deployment | Missing | API keys, teams/projects, audit log, Postgres, Redis/BullMQ, Docker | Claude-Mem |
| Storage simplicity | One SQLite database, direct tables | Multiple local schemas, Chroma synchronization, legacy compatibility, server schemas | Termyte |
| Windows development | Node/npm; tests pass on this machine | Requires Bun and uv; repository scripts include POSIX-oriented commands | Termyte |
| Maintainability | Small and cohesive | Large, duplicated local/server/compatibility architecture | Termyte |
| Verified tests here | 136/136 passed | Not executable without Bun/dependencies | Termyte for current evidence |
| Product maturity | Early `0.1.0` | Version `13.8.0`, extensive installer/compatibility/runtime logic | Claude-Mem |

## Claim-by-claim verdicts

### Claim: Termyte provides a real persistent coding-agent memory pipeline

**Verdict: VERIFIED**

Evidence is executable: hook adapters persist traces; observer/synthesis code produces observations and memories; SQLite stores them; FTS/vector retrieval and MCP access are tested.

Weakness: production retries are inadequate. In the standalone observer, a Stage 1 exception marks the trace processed, and a consolidation exception marks observations processed. This prevents retry storms but silently trades recoverability for data loss.

Smallest required improvement: add explicit `pending`, `processing`, `failed`, retry count, last error, and next-attempt fields rather than overloading `processed_at`.

### Claim: Claude-Mem provides persistent memory across sessions

**Verdict: VERIFIED**

The local schema persists sessions, observations, summaries, user prompts, feedback, and a durable pending queue. Context rendering, search, hook capture, and session-completion paths consume these records. This is not a README-only feature.

Bypass/failure: hooks deliberately fail open for unavailable workers in several cases, so capture is best-effort rather than guaranteed. If the worker is unavailable, the coding agent continues and that event may not enter memory.

Production risk: memory completeness cannot be guaranteed without an agent-side spool or transcript reconciliation.

### Claim: Claude-Mem has crash-resilient generation

**Verdict: PARTIALLY_IMPLEMENTED**

The durable local queue, deduplication constraints, session buffers, provider error handling, supervisor, and server job transitions are substantial. The server path has stronger job lifecycle and idempotency semantics than Termyte.

It is not fully guaranteed because local hooks can fail open, some session context is held in RAM, and worker/provider restarts can lose conversational generation context. The code explicitly handles lost SDK context by starting fresh rather than reconstructing it perfectly.

Smallest required improvement: persist enough generator conversation state to resume deterministically and add an agent-side spool for events accepted while the worker is down.

### Claim: Claude-Mem offers hybrid retrieval

**Verdict: PARTIALLY_IMPLEMENTED**

SQLite FTS and Chroma semantic retrieval both exist. The orchestrator chooses strategies and the `HybridSearchStrategy` performs SQLite metadata filtering followed by Chroma ranking and intersection.

This is operationally useful, but the inspected local hybrid strategy is not a conventional score fusion between lexical and semantic rankings. It uses metadata candidates and Chroma ordering. Calling it “hybrid” is reasonable at the system level, but claims about sophisticated rank fusion would be overstated.

Termyte's RRF is algorithmically clearer, although its vector branch is an O(n) scan and its optional `sqlite-vec` table is not used for retrieval.

### Claim: Claude-Mem is a multi-agent memory layer rather than only a Claude plugin

**Verdict: VERIFIED, WITH LIMITATIONS**

Codex, Cursor, Gemini, Windsurf, OpenCode, OpenClaw, MCP, and transcript integration code is present. Platform scoping is represented in sessions/search, and installers generate native configurations.

Limitations: Claude remains architecturally privileged. The product depends on Bun, several flows use Claude Agent SDK/OAuth behavior, and integration depth differs by platform. MCP-only clients receive search/context but not necessarily full automatic capture and summarization.

### Claim: either product is enterprise-grade by default

**Verdict: MISLEADING**

Termyte has no multi-user auth, encryption, audit, retention controls, SLO machinery, or distributed scaling.

Claude-Mem's server path contains real auth, audit, queues, Postgres, teams, and Docker infrastructure, but the local product still uses localhost trust and fail-open hooks. Running the server path securely requires Redis/Postgres operations, secret management, backups, monitoring, tenancy validation, and deployment hardening that were not proven by this local audit.

## Capture and provenance

Termyte's most defensible advantage is its immutable local trace ledger. Tool input/output is persisted before enrichment. Observations reference trace IDs; memories reference both observations and traces. An operator can inspect what the model saw and regenerate derived data.

Claude-Mem's local path stores tool input/response in `pending_messages`, but that table is primarily a queue rather than a permanent raw-event ledger. Once generation succeeds, the durable product record is the observation/summary. Claude-Mem's newer server architecture corrects this with `agent_events`, `memory_items`, and `memory_sources`, but that provenance model is not the same as the default local worker schema.

**Verdict: Termyte wins local event provenance. Claude-Mem server wins multi-user provenance and audit.**

## Enrichment quality and lifecycle

Termyte has a legible two-stage pipeline, but it is shallow:

- No confidence or importance score.
- No conflict/supersession model.
- No observation feedback loop.
- No durable generator state.
- No privacy suppression protocol beyond whatever the source agent provides.
- No lifecycle/retention management.

Claude-Mem keeps stateful generation conversations, tracks prompt numbers and discovery tokens, deduplicates observations by content hash, records model/agent metadata, supports feedback, creates structured summaries, handles private prompts, and provides corpus/knowledge-agent functions.

**Verdict: Claude-Mem wins decisively.**

## Retrieval quality and scalability

Termyte's FTS5 is transactionally synchronized and RRF is easy to verify. However, every semantic query loads all embedded memories and computes cosine similarity. That is suitable only for modest local corpora. The created `sqlite-vec` virtual table currently provides no runtime acceleration.

Claude-Mem delegates semantic retrieval to Chroma and hydrates records from SQLite. It also searches observations, summaries, and prompts with project/platform/type/concept/file/date filters and exposes timeline navigation. This has better practical scaling and discovery capability, at the cost of running and synchronizing a second storage system.

Chroma is a consistency boundary. Claude-Mem contains sync watermarks and fallback paths because vectors can lag or fail independently of SQLite. Termyte avoids this class of drift but pays with linear scans.

**Verdict: Claude-Mem wins functionality and scale; Termyte wins consistency and debuggability.**

## Reliability and operational behavior

Claude-Mem is substantially ahead:

- Persistent pending-message queue.
- Unique tool-use and content-hash deduplication.
- Provider-specific error classification and retries.
- Worker supervision, process registry, health checks, and graceful shutdown.
- Search fallback when Chroma is unavailable.
- Hook I/O discipline and platform-specific installers.
- Server job lifecycle and idempotent generation persistence.

Its reliability cost is complexity. The system must coordinate hooks, a local HTTP worker, Bun, SQLite, Chroma/uv, provider sessions, generated plugin artifacts, and optionally Redis/Postgres. More recovery code exists because more components can fail.

Termyte has fewer failure modes and passed locally with ordinary Node tooling, but its retry semantics are not acceptable for a product whose value depends on retaining events.

**Verdict: Claude-Mem wins operational maturity. Termyte has the more reliable dependency graph, not the more reliable processing behavior.**

## Security and privacy

Neither product should be described as a security boundary.

Termyte minimizes exposure by staying local and not running a general REST server. It lacks encryption at rest, redaction, access controls, audit logging, configurable retention, and secure deletion guarantees.

Claude-Mem binds local health/worker services to loopback in inspected code and implements privacy checks, environment sanitization, telemetry consent, bounded/redacted error telemetry, server API keys, team/project scoping, and audit records. Those are material controls. Risks remain:

- Tool payloads and source context remain sensitive local data.
- Localhost processes share the user's trust boundary.
- Chroma and SQLite create multiple copies that deletion/export logic must cover.
- Server deployment expands the network and tenancy attack surface.
- Telemetry safety depends on consent and scrubber correctness.

**Verdict: Claude-Mem has significantly better controls; Termyte has a smaller attack surface.**

## Maintainability

Termyte is small enough for one engineer to understand end to end. Its data model is centralized and its tests run with standard Node/npm tooling.

Claude-Mem's repository contains local worker schemas, newer generic storage schemas, Postgres equivalents, server compatibility adapters, generated plugin artifacts, multiple installers, a viewer, supervisor, telemetry system, and several provider implementations. This is real infrastructure, not architectural theater, but it imposes a high maintenance tax. Behavior can diverge between local, server, SQLite, Postgres, Chroma, and compatibility paths.

The repository instruction to upgrade every dependency including major versions daily is also operationally aggressive. It increases supply-chain and regression risk unless automation and compatibility tests are exceptionally strong.

**Verdict: Termyte wins maintainability and auditability.**

## Scored assessment

These scores assess the inspected implementations, not reproduced retrieval benchmarks.

| Category | Weight | Termyte | Claude-Mem |
|---|---:|---:|---:|
| Capture and provenance | 15 | 13 | 12 |
| Memory formation/lifecycle | 20 | 8 | 17 |
| Retrieval | 20 | 10 | 16 |
| Reliability/data integrity | 15 | 9 | 13 |
| Integrations/operability | 15 | 8 | 14 |
| Maintainability/auditability | 10 | 9 | 5 |
| Security/privacy controls | 5 | 2 | 4 |
| **Total** | **100** | **59** | **81** |

## Final conclusion: which is better?

### For users today

**Choose Claude-Mem.** It is a much more complete coding-agent memory product. Its durable queue, provider recovery, semantic retrieval, context injection, integrations, UI, operational tooling, and privacy controls outweigh its complexity.

### For a team choosing code to own

Choose Termyte when these are explicit priorities:

- Standard Node rather than Bun/uv/Chroma.
- One directly owned SQLite database.
- Immutable local event provenance.
- A small codebase that can be audited end to end.
- Willingness to build missing reliability and lifecycle features.

Choose Claude-Mem when accepting its runtime stack is cheaper than rebuilding years of integration and operational behavior.

### Strategic conclusion for Termyte

Termyte is described as a port of Claude-Mem stripped to MVP essentials. The current code confirms that relationship: it preserves the observation/consolidation idea while replacing Claude-Mem's worker/service breadth with a direct SQLite model.

That simplification is useful engineering, but it is not yet a strong product differentiator. Claude-Mem has already expanded beyond the architecture Termyte copied. Competing by rebuilding Claude-Mem's feature list would leave Termyte permanently behind.

Termyte should instead make five claims demonstrably true:

1. **Every event is recoverable:** durable retries, dead letters, failure metadata, and replay.
2. **Every memory is explainable:** trace-to-observation-to-memory lineage exposed through CLI/MCP.
3. **Local means simple:** Node + one SQLite file, no daemon stack, no Chroma, predictable Windows behavior.
4. **Retrieval quality is measured:** reproducible shared-corpus benchmarks against Claude-Mem.
5. **Agent-native synthesis is cheaper:** prove that Claude/Codex/Gemini CLI subscription-based synthesis works reliably without separate API infrastructure.

Until those are implemented and benchmarked, **Claude-Mem is objectively better as a product, while Termyte is a cleaner but substantially less mature reimplementation.**

## Top engineering priorities for Termyte

1. Replace binary `processed_at` with durable work states, retry counts, error text, and dead-letter handling.
2. Never mark failed enrichment/consolidation successful merely to avoid retries.
3. Expose trace provenance and replay through MCP and CLI.
4. Use `sqlite-vec` in the real query path or remove the unused table.
5. Add deterministic idempotency keys for observations and memories.
6. Add confidence, supersession/conflict, retention, and deletion semantics.
7. Persist embedding failures and retry them.
8. Add privacy/redaction controls before sending tool data to any model or agent CLI.
9. Build identical-corpus retrieval and end-to-end continuity evaluations against Claude-Mem.
10. Add install/doctor/package validation that proves live hooks, synthesis, retrieval, and context injection on every supported agent.

## Second-pass critique

- Claude-Mem could not be executed because Bun and dependencies were absent. Its score may move after clean-room installation and live hook tests.
- Termyte's passing tests prove deterministic internal behavior, not useful real-world long-term memory.
- Claude-Mem's 2,116 test declarations do not prove that all tests pass or that they are independent/high-value.
- Retrieval quality was inferred from executable mechanisms, not measured head to head. A simpler RRF system could outperform a larger Chroma system on a specific coding corpus.
- Claude-Mem's server architecture received credit as implemented infrastructure, but most local users may never exercise it.
- Termyte's raw traces are a meaningful architectural advantage only if replay, inspection, and repair become first-class product surfaces.
- Claude-Mem's dependency and architectural complexity may cause more installation failures than static inspection reveals. Clean-room Windows installation remains necessary.
