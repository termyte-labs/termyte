# Termyte Overview

Termyte is the best persistent memory layer for coding agents.
It captures agent execution as traces, derives observations and memories from those traces, and exposes retrieval through CLI, MCP, hook injection, and a local diagnostics viewer.

This repository is real software, not a pitch deck. The durable pipeline, provenance, feedback, lifecycle, and ranking pieces exist. The closed loop that proves a memory helped or harmed a task and then repairs future retrieval is still incomplete.

## Repository Shape

- `src/capture`: platform adapters, event normalization, and file-path extraction
- `src/cli`: command-line entry points and per-command handlers
- `src/context`: ranked context packing and injection tracking
- `src/eval` and `src/benchmark`: evaluation harnesses and retrieval benchmarks
- `src/explain`: provenance and lifecycle explanation rendering
- `src/hooks`: hook runner
- `src/integrations`: installers for Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Windsurf, and MCP-only setups
- `src/lifecycle`: decay, deduplication, and feedback state transitions
- `src/mcp`: stdio MCP server, tool schema, and validation
- `src/observer`: prompts, XML parsing, and the LLM-backed observation pipeline
- `src/pipeline`: durable jobs, worker execution, and worker supervision
- `src/retrieval`: FTS, vector, hybrid search, ranking, and eligibility policy
- `src/security`: deterministic redaction before persistence and LLM calls
- `src/storage`: SQLite schema, migrations, document corpus, and repository state access
- `src/synth`: agent-driven batch synthesis path and CLI adapters
- `src/viewer`: local HTTP diagnostics viewer

## System Flow

```mermaid
flowchart LR
  A[Agent event] --> B[PlatformAdapter.normalize()]
  B --> C[HookRunner]
  C --> D[Redaction + trace insert]
  D --> E[Durable jobs]
  E --> F[Detached termyte-worker]
  F --> G[Observation pipeline]
  G --> H[Memories + summaries]
  H --> I[FTS5 + sqlite-vec + scan fallback]
  I --> J[ContextBuilder / CLI / MCP / hooks]
  J --> K[Context injections + feedback]
  K --> I
```

Hooks capture and enqueue first. They do not do the heavy work inline. A detached worker drains the queue under leases and retries.

## Storage Model

SQLite is the source of truth.

| Area | Tables / Indexes | Role |
|---|---|---|
| Sessions and traces | `sessions`, `traces` | Immutable capture and repository scope |
| Durable work | `jobs` | Leases, retries, backoff, dead letters |
| Derived knowledge | `observations`, `memories`, `summaries` | Structured evidence and consolidated memory |
| Provenance | `trace_observations`, `observation_memories`, `memory_edges` | Explicit lineage and relationships |
| Feedback | `memory_feedback`, `context_injections`, `context_injection_items` | Exposure, usage, correction, and ranked injection sets |
| Search corpus | `documents`, `documents_fts`, `document_embeddings` | Typed retrieval for trace, observation, memory, summary, and episode documents |
| Keyword search | `observations_fts`, `memories_fts` | FTS mirrors for derived knowledge |
| Vector search | `memories_vec` and document vec helpers | sqlite-vec acceleration with fallback scanning |

The store preserves repository, workspace, session, observation, and trace provenance through every derived artifact.

## What Works

- platform adapters for the supported agents
- immutable trace capture
- durable jobs with worker supervision
- trace to observation to memory processing
- local embeddings and hybrid retrieval
- typed retrieval for the document corpus
- context injections and explainability
- explicit feedback persistence
- local diagnostics, smoke checks, and benchmarks

## What Does Not Work Yet

- the system is not self-correcting
- automatic outcome attribution is not implemented
- correction text is not verified against repository evidence
- ranking calibration is still conservative
- OpenCode still uses a shared context file refresh path instead of a true live injected memory object
- the redaction layer is heuristic, not comprehensive

## Public Docs

- [README.md](README.md)
- [docs/README.md](docs/README.md)
- [docs/how-it-works.md](docs/how-it-works.md)
- [docs/comparisons.md](docs/comparisons.md)
- [docs/limitations.md](docs/limitations.md)
