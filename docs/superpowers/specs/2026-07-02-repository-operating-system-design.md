# Termyte Repository Operating System Design

## Objective

Create three coordinated repository documents that keep future engineering work aligned with Termyte's current implementation and its target of becoming a self-correcting memory layer for coding agents.

The documents are:

- `README.md`: honest public product and usage documentation;
- `AGENTS.md`: internal repository and founding-team operating instructions;
- `PLAN.md`: live implementation tracker for closing the gap between the current product and the target architecture.

## Core Rule

Executable code, schemas, tests, built artifacts, generated configurations, and observable CLI behavior define the current product. Documentation must clearly separate implemented behavior, partial behavior, known defects, and target architecture.

The documents must not describe lifecycle scaffolding as self-correction until outcome attribution changes future retrieval behavior.

## README.md

The README will provide:

- a concise statement that Termyte is currently a local-first coding-agent memory layer under active development;
- the implemented trace to observation to memory pipeline;
- durable jobs, typed retrieval, FTS and vector behavior, MCP, hooks, and supported adapters;
- a distinction between implemented capabilities and incomplete self-correction;
- accurate source-checkout commands and configuration;
- explicit packaging and automatic-processing caveats where current behavior is broken or incomplete;
- validation commands and test scope;
- a short roadmap link to `PLAN.md`.

The README must not retain stale table counts, obsolete schemas, hosted embedding variables, inline hook processing claims, or automatic synthesis claims unsupported by installed commands.

## AGENTS.md

AGENTS.md will become the internal execution contract for any coding agent working in the repository.

It will contain:

- current architecture, schema, command, and module knowledge;
- current product gaps and prohibited overclaims;
- repository conventions and testing requirements;
- the five founding-engineer skills under `.agents/skills`;
- task-routing rules selecting one lead skill and only necessary supporting skills;
- cross-domain handoff requirements;
- authority to inspect, design, implement, and validate within task scope;
- escalation conditions for product-direction, destructive, publishing, deployment, and unresolved cross-domain decisions;
- a standard execution loop: inspect, classify, design, implement, validate, update plan, report;
- task completion requirements and validation tiers.

## Founding-Team Routing

Each task has one accountable lead:

- `agent-runtime-execution-systems-lead`: hooks, adapters, installers, jobs, workers, crash recovery, and runtime execution;
- `code-intelligence-lead`: files, commands, diffs, tests, stack traces, symbols, indexing, and applicability evidence;
- `memory-modeling-knowledge-architecture-lead`: trace/observation/memory semantics, provenance, lifecycle, feedback, correction, conflicts, and supersession;
- `retrieval-search-ranking-lead`: typed routing, candidate generation, FTS/vector search, ranking, filters, context packing, and injection;
- `evaluation-benchmarking-lead`: metrics, corpora, fault injection, experiments, regressions, and claim strength.

Supporting skills are included only where a task crosses an explicit interface. The lead remains accountable for integration and final validation.

## PLAN.md

PLAN.md will be a live tracker, not an aspirational essay.

Each task will include:

- stable task ID;
- status: `pending`, `in_progress`, `blocked`, or `completed`;
- lead founding-engineer skill;
- supporting skills where required;
- problem and current evidence;
- dependencies;
- implementation deliverables;
- acceptance criteria;
- validation commands or experiments.

The initial phases will be ordered by dependency:

1. Packaging and executable correctness
2. Automatic durable processing
3. Lifecycle execution and state-aware retrieval
4. Context injection attribution and feedback
5. Correction, verification, conflict, and supersession
6. Independent evaluation and agent-outcome experiments
7. Secret redaction and local data controls
8. Live platform integration proof
9. Scale, observability, and operational reliability
10. Self-correction product proof

## Plan Update Protocol

Before work, the active engineer selects a task and marks it `in_progress`. Only one task should be in progress unless independent work is explicitly coordinated.

After implementation:

1. Run the task's acceptance checks.
2. Update evidence and status in PLAN.md.
3. Mark `completed` only when every acceptance criterion passes.
4. Mark `blocked` only with a concrete external dependency or required founder decision.
5. Add newly discovered work under the correct phase rather than hiding it in a completion note.

## Validation

Documentation validation will include:

- verify every stated command and path against the current checkout;
- check README and AGENTS for obsolete table counts, inline-processing claims, hosted embedding variables, and automatic-synthesis claims;
- check every PLAN task has an owner, dependencies, acceptance criteria, and validation;
- run `npm run typecheck`, `npm test`, and `npm run build` to confirm the documented baseline;
- run the built evaluation command from `dist/cli/index.js` while clearly documenting that current retrieval metrics are contaminated and not product proof;
- run `git diff --check` on edited files.

## Acceptance Criteria

- README accurately describes the current product and limitations.
- AGENTS routes work efficiently through the five founding-engineer skills.
- PLAN is actionable without requiring future agents to rediscover the audit.
- Every critical audit finding appears in at least one prioritized plan task.
- No document claims the current product is already self-correcting.
- No unrelated working-tree changes are modified or staged.
