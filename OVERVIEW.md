# Termyte Overview

Termyte is a local execution, task-state, and memory layer for coding agents.
It captures agent execution as an idempotent event ledger, maintains evidence-backed task state, derives reusable memories, and exposes continuity through CLI, MCP, context injection, handoffs, and a local diagnostics viewer.

This repository is real software, not a pitch deck. The durable pipeline, provenance, feedback, lifecycle, and ranking pieces exist. The closed loop that proves a memory helped or harmed a task and then repairs future retrieval is still incomplete.

## Repository Shape

- `src/capture`: platform adapters, event normalization, and file-path extraction
- `src/cli`: command-line entry points and per-command handlers
- `src/context`: ranked context packing and injection tracking
- `src/eval` and `src/benchmark`: evaluation harnesses and retrieval benchmarks
- `src/explain`: provenance and lifecycle explanation rendering
- `src/hooks`: hook runner
- `src/integrations`: installers for Claude Code and Codex
- `src/lifecycle`: decay, deduplication, and feedback state transitions
- `src/mcp`: stdio MCP server, tool schema, and validation
- `src/observer`: prompts, XML parsing, and the LLM-backed observation pipeline
- `src/pipeline`: durable jobs, worker execution, and worker supervision
- `src/retrieval`: FTS, vector, hybrid search, ranking, and eligibility policy
- `src/security`: deterministic redaction before persistence and LLM calls
- `src/storage`: SQLite schema, migrations, document corpus, and repository state access
- `src/synth`: Claude Code/Codex synthesis adapters and shared prompts
- `src/task-state`: authoritative tasks, evidence gates, checkpoints, resume packets, and handoffs
- `src/viewer`: local HTTP diagnostics viewer

## System Flow

```mermaid
flowchart LR
  A[Agent event] --> B[PlatformAdapter.normalize()]
  B --> C[HookRunner]
  C --> D[Redaction + idempotent event ledger]
  D --> E[Execution projections + durable jobs]
  E --> F[Detached termyte-worker]
  F --> G[Observation pipeline]
  G --> H[Memories + summaries]
  H --> I[FTS5 + sqlite-vec + scan fallback]
  I --> J[Authoritative task state + historical context]
  J --> K[Context injections + feedback]
  K --> I
```

Hooks capture and enqueue first. They do not do the heavy work inline. A detached worker drains the queue under leases and retries.

## Storage Model

SQLite is the source of truth.

| Area | Tables / Indexes | Role |
|---|---|---|
| Sessions and traces | `sessions`, `traces` | Immutable capture and repository scope |
| Execution projections | `prompts`, `tool_calls`, `commands`, `file_changes` | Deterministic views of captured work |
| Task continuity | `tasks`, `task_requirements`, `task_steps`, `task_decisions`, `task_failures`, `verification_evidence`, `checkpoints`, `handoffs`, `task_transitions` | Authoritative work state, verification, drift, and transfer |
| Durable work | `jobs` | Leases, retries, backoff, dead letters |
| Derived knowledge | `observations`, `memories`, `summaries` | Structured evidence and consolidated memory |
| Provenance | `trace_observations`, `observation_memories`, `memory_edges` | Explicit lineage and relationships |
| Feedback | `memory_feedback`, `context_injections`, `context_injection_items` | Exposure, usage, correction, and ranked injection sets |
| Search corpus | `documents`, `documents_fts`, `document_embeddings` | Typed retrieval for trace, observation, memory, summary, and episode documents |
| Keyword search | `observations_fts`, `memories_fts` | FTS mirrors for derived knowledge |
| Vector search | `memories_vec` and document vec helpers | sqlite-vec acceleration with fallback scanning |

The store preserves repository, workspace, session, observation, and trace provenance through every derived artifact.

## What Works

- Claude Code, Codex, and OpenCode capture adapters
- replay-safe trace capture and additive migration
- evidence-backed task state with optimistic concurrency
- checkpoints, drift-aware resume packets, and immutable handoffs
- durable jobs with worker supervision
- trace to observation to memory processing
- local embeddings and hybrid retrieval
- typed retrieval for the document corpus
- context injections and explainability
- explicit feedback persistence
- local diagnostics and retrieval benchmarks

## What Does Not Work Yet

- OpenCode synthesis and dynamic context injection are not implemented
- import/export/delete operations are not implemented
- the Viewer exposes task data through APIs but has no task-management UI
- live three-agent acceptance proof is not complete
- ranking calibration is still conservative
- the redaction layer is heuristic, not comprehensive

## Public Docs

- [README.md](README.md)
- [docs/README.md](docs/README.md)
- [docs/how-it-works.md](docs/how-it-works.md)
- [docs/comparisons.md](docs/comparisons.md)
- [docs/limitations.md](docs/limitations.md)
