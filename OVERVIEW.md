# Termyte Overview

Termyte gives coding agents the project context they need, so developers do not have to repeatedly explain what happened, why, and what remains.
It captures agent work as an idempotent local event ledger, keeps task state and evidence, derives reusable observations, and supplies context through hooks, MCP, the CLI, and a local diagnostics viewer.

This repository is real software, not a pitch deck. The durable pipeline, provenance, feedback, lifecycle, and ranking pieces exist. The closed loop that proves a memory helped or harmed a task and then repairs future retrieval is still incomplete.

## Repository Shape

- `src/agents`: agent adapters, hooks, installers, and synthesis callers
- `src/capture`: generic event normalization, file-path extraction, and session recording
- `src/cli`: command-line entry points and per-command handlers
- `src/context`: observations, retrieval, indexing, lifecycle, durable jobs, and context packing
- `src/eval` and `src/benchmark`: evaluation harnesses and retrieval benchmarks
- `src/server`: MCP server boundary
- `src/shared`: shared types and deterministic redaction
- `src/storage`: SQLite schema, migrations, document corpus, and repository state access
- `src/tasks`: authoritative tasks, evidence gates, checkpoints, resume packets, and handoffs
- `src/viewer`: local HTTP diagnostics viewer

## System Flow

```mermaid
flowchart LR
  A[Agent event] --> B[HookRunner]
  B --> C[Capture + normalization]
  C --> D[Redaction + idempotent event ledger]
  D --> E[Execution projections + durable jobs]
  E --> F[Detached termyte-worker]
  F --> G[Context processing]
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
