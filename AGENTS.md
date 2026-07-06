# AGENTS.md

## Purpose

This file is the execution contract for engineering Termyte. Use it with `PLAN.md` and the founding-engineer skills under `.agents/skills`.

Termyte is building a self-correcting memory layer for coding agents. The current product is a local-first capture, memory-construction, and retrieval prototype with durable processing foundations. It is not yet self-correcting.
Whenever Agentmemory, mem0, claude-mem is mentioned and the user asks how certain components of each product works refer to this folder:"C:\Users\Palguna\Desktop\competitors", it contains the code of all the products.

## Source of truth

Trust, in order:

1. executable runtime paths;
2. SQLite schema and migrations;
3. persistence and enforcement behavior;
4. tests and built-artifact smoke checks;
5. generated integration configuration;
6. documentation.

Do not promote comments, roadmap text, schemas without callers, passing mock tests, or CLI messages into product claims.

Always separate:

- **implemented**: wired into a real runtime path and validated;
- **partial**: substantial code exists but the end-to-end outcome is incomplete;
- **scaffolded**: types, schema, helpers, or jobs exist without production wiring;
- **planned**: tracked in `PLAN.md` only.

## Current product truth

Implemented:

- adapter normalization for Claude Code, Codex, Cursor, OpenCode, Gemini CLI, Windsurf, and raw payloads;
- SQLite trace persistence;
- durable jobs with leases, retries, backoff, idempotent subject keys, and dead-letter state;
- hook-initiated worker supervision: `termyte-hook` starts a detached, single-instance-locked `termyte-worker` after each ingest;
- trace to observation to memory processing with provenance;
- local embeddings, FTS5, sqlite-vec cosine search with an in-memory fallback, and reciprocal-rank fusion;
- typed document retrieval for trace, observation, memory, summary, and episode documents;
- hook context handlers, MCP tools, explicit memory feedback persistence, and local diagnostics;
- deterministic unit and integration tests.

Known incomplete behavior:

- decay helpers have no production caller (dedupe now runs as a durable job);
- lifecycle eligibility and bounded confidence/importance/decay/usage/feedback ranking are active; public-corpus calibration and automatic outcome attribution remain incomplete;
- context injection IDs and automatic outcome attribution are absent;
- sqlite-vec memory search is active; typed document-vector retrieval remains scaffolded;
- MCP `explain` and MCP health fields are placeholders;
- OpenCode writes placeholder context instead of real memory context;
- retrieval evaluation contaminates candidates with expected terms;
- trace data is not protected by a comprehensive secret-redaction layer.

## Architecture

```text
Agent event
  -> PlatformAdapter.normalize()
  -> HookRunner
  -> Ingestor
  -> traces
  -> jobs: extract_observation
  -> observations
  -> jobs: embed_observation
  -> documents
  -> jobs: consolidate_memory
  -> memories
  -> jobs: embed_memory
  -> memory/document indexes
  -> search/context/MCP/hook injection
```

`termyte-hook` captures and enqueues; it intentionally does not drain the queue itself, but it asks the `WorkerSupervisor` to start a detached `termyte-worker` (single-instance-locked per database) that drains durable jobs without blocking the agent. `termyte synth` invokes a coding-agent CLI to generate observations, then queues downstream work.

## Persistence model

Core tables in `src/storage/migrations.ts`:

- `sessions`
- `traces`
- `jobs`
- `observations`
- `memories`
- `summaries`
- `memory_edges`
- `memory_feedback`
- `documents`
- `document_embeddings`

Virtual indexes:

- `observations_fts`
- `memories_fts`
- `documents_fts`
- optional `memories_vec` and dimension-specific document vec tables

JSON arrays are stored as TEXT. Embeddings are Float32 BLOBs. Preserve repository, workspace, session, observation, and trace provenance through every derived artifact.

## Founding engineering team

The five skills are persistent technical owners, not advisory checklists. A task should have one lead owner. Add supporting owners only when the change crosses a defined interface.

### Runtime and execution systems

Skill: `.agents/skills/agent-runtime-execution-systems-lead/SKILL.md`

Lead for:

- adapters, hooks, installers, ingestion;
- process launching, workers, jobs, leases, retries, crash recovery;
- runtime observability and cross-platform behavior;
- built CLI and integration execution.

### Code intelligence

Skill: `.agents/skills/code-intelligence-lead/SKILL.md`

Lead for:

- files, paths, diffs, commands, tests, stack traces, symbols, dependencies;
- repository evidence extraction and normalization;
- document indexing and technical applicability signals.

### Memory modeling and knowledge architecture

Skill: `.agents/skills/memory-modeling-knowledge-architecture-lead/SKILL.md`

Lead for:

- trace, observation, memory, summary, and episode semantics;
- provenance, consolidation, lifecycle, confidence, feedback;
- correction, conflict, deduplication, supersession, and deletion.

### Retrieval, search, and ranking

Skill: `.agents/skills/retrieval-search-ranking-lead/SKILL.md`

Lead for:

- typed routing, FTS, embeddings, vectors, fusion, filters, ranking;
- context packing, injection selection, and retrieval fallbacks;
- relevance, harmful recall, and query-time performance.

### Evaluation and benchmarking

Skill: `.agents/skills/evaluation-benchmarking-lead/SKILL.md`

Lead for:

- regression corpora, metrics, thresholds, fault injection;
- controlled agent experiments and baseline design;
- proof strength, failure reporting, and public claims.

## Task routing

Route by the first invariant that can fail:

| Task | Lead | Typical support |
|---|---|---|
| Hook does not capture or worker does not run | Runtime | Memory Modeling |
| File, test, stack, or symbol evidence is wrong | Code Intelligence | Runtime |
| Wrong knowledge is created or lifecycle is inconsistent | Memory Modeling | Code Intelligence, Evaluation |
| Correct memory exists but is missing or badly ranked | Retrieval | Memory Modeling, Evaluation |
| A metric or product claim is untrustworthy | Evaluation | Owning implementation skill |
| Full self-correction loop | Memory Modeling | Runtime, Retrieval, Evaluation, Code Intelligence as needed |

Do not invoke all five skills by default. That dilutes accountability and adds unnecessary context.

## Cross-domain handoffs

A handoff must state:

- the interface being changed;
- the invariant the receiving owner must preserve;
- inputs and outputs;
- failure behavior;
- acceptance test expected from the receiving owner.

The lead owner remains responsible for the integrated result. “Another subsystem owns it” is not a completion condition.

## Authority and escalation

Within an authorized implementation task, the lead engineer may inspect, design, edit, test, simplify, and validate without requesting approval for routine technical decisions.

Stop for founder direction before:

- changing Termyte's product thesis or public promise;
- introducing a major external service or new top-level subsystem;
- changing privacy, sharing, or customer-data policy;
- publishing packages, pushing branches, deploying, or mutating external systems unless explicitly requested;
- destructive or irreversible operations;
- choosing an unresolved product tradeoff between founding domains.

For review, explanation, or diagnosis-only requests, remain read-only.

## Standard execution loop

1. Read `PLAN.md` and select the relevant task ID.
2. Load the lead founding-engineer skill.
3. Inspect the current code path and revalidate the task evidence.
4. Mark the task `in_progress` only when implementation begins.
5. State the outcome and invariant being protected.
6. Implement the smallest coherent end-to-end change.
7. Add tests that fail without the change.
8. Run narrow validation, then the required repository validation tier.
9. Update `PLAN.md` evidence and status.
10. Report code changed, proof obtained, limitations, and next dependency.

Never mark a plan task completed because code was written. Every listed acceptance criterion must pass.

## Validation tiers

### Tier 1: focused change

- affected test file or focused Vitest pattern;
- `npm run typecheck`.

### Tier 2: repository change

```bash
npm run typecheck
npm test
npm run build
```

### Tier 3: packaging, runtime, retrieval, or product claim

Run Tier 2 plus the relevant built-artifact checks, for example:

```bash
node dist/cli/index.js help
node dist/cli/index.js eval --suite all --json
npm pack --dry-run --json
```

For package work, install the tarball into a clean temporary project and execute every declared binary. For integration work, inspect generated configuration and run representative built-hook payloads. For product claims, require controlled live-agent evidence.

## Engineering conventions

- TypeScript strict mode, ESM, NodeNext resolution.
- Source imports use `.js` extensions.
- Node.js 20 or newer.
- SQLite through `better-sqlite3`, WAL mode, foreign keys enabled.
- Vitest uses `pool: "forks"` with `singleFork: true`.
- Local embeddings are dynamically loaded from `@xenova/transformers`.
- Preserve FTS-only retrieval when embeddings fail.
- Use migrations and compatibility guards for schema changes.
- Make background jobs idempotent and crash-safe.
- Never silently swallow durable-work failures; expose retry/dead-letter state.
- Treat LLM output as untrusted structured input.
- Redact sensitive data before persistence and before external LLM calls.

## Important implementation traps

1. Ranking consumes feedback and lifecycle fields, but its bounded weights are not yet calibrated on public corpora.
2. Context returns no injection identity, preventing outcome attribution.
3. The evaluation harness injects expected keywords and queries into candidates.
4. sqlite-vec memory search uses bounded candidate overfetch before lifecycle and repository filtering; validate filtered-corpus recall at scale.
5. OpenCode writes placeholder context instead of real memory context.

## Documentation protocol

Update documentation in the same change when commands, schemas, integration behavior, configuration, or product boundaries change.

README describes current user-visible truth. AGENTS describes durable engineering conventions and ownership. PLAN tracks incomplete work. Do not use README as a backlog or PLAN as marketing.

## Completion report

Every implementation handoff should include:

- task ID and lead skill;
- changed behavior;
- affected files;
- tests and commands run;
- observable proof;
- remaining limitations;
- PLAN status change;
- any founder decision still required.
