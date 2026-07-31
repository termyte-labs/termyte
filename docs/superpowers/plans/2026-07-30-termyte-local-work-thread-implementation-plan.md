# Termyte local Work Thread implementation plan

**Design:** [2026-07-30-termyte-local-work-thread-design.md](../specs/2026-07-30-termyte-local-work-thread-design.md)  
**Scope:** simplify and evolve the existing `termyte` repository into the approved local-only Work Thread product.

## Outcome

After this plan, a local coding-agent session will produce this verifiable path:

```text
hook event
  -> durable SQLite evidence
  -> task continuation/new-task decision
  -> Work Thread observations and attempts
  -> current-state validation
  -> bounded Context Briefing
  -> agent action and local verification
  -> attributed outcome
```

The plan does not add GitHub, Slack, Linear, Jira, hosted storage, hosted retrieval, graph databases, or external connectors.

## Existing foundation

Preserve and connect these current paths:

- Capture and adapters: `src/capture/`, `src/hooks/`, `src/integrations/installers/`.
- SQLite and migrations: `src/storage/`.
- Durable processing: `src/pipeline/`.
- Task state: `src/task-state/`.
- Context assembly: `src/context/`.
- Retrieval: `src/retrieval/`.
- Local Git and context attribution: `src/experience/`.
- LLM interpretation: `src/observer/`, `src/synth/`.
- Local CLI/MCP: `src/cli/`, `src/mcp/`.
- Existing evaluation: `src/benchmark/`, `src/eval/`, `test/`.

Before changing behavior, produce a table mapping each database table and TypeScript type to its actual writers, readers, indexes, and tests. This prevents a migration from leaving a dead or duplicate path.

## Non-negotiable invariants

1. Raw evidence is durable before enrichment starts.
2. Hook capture never blocks on an LLM, embedding, or broad retrieval operation.
3. Every derived observation has valid source-event provenance.
4. One Work Thread is authoritative for one local coding task.
5. Ambiguous task assignment is visible and does not silently merge work.
6. Current repository state can invalidate old context.
7. Unsupported, stale, conflicted, and deleted claims do not appear as active truth.
8. Context delivery is bounded and persisted.
9. Completion requires local verification evidence or explicit user confirmation.
10. Retries, duplicate events, worker crashes, and provider failures are safe.
11. FTS5 works without embeddings.
12. The built CLI and installed hooks behave like the source checkout.

## Decision gate: synthesis provider

The existing repository contains fake, agent-CLI, and OpenAI-style providers. The evidence model and pipeline must not depend on one provider.

Default plan assumption: local storage and integrations are mandatory; synthesis may use a configured provider through the existing provider interface. If Termyte must also perform synthesis with zero network access and no local model installed, the product must support a deterministic-only mode and report lower synthesis coverage. This is the only unresolved decision that changes implementation effort materially.

## Phase 0 — repository map and contract freeze

### Work

- Inspect every current migration and storage write/read path.
- Map `Trace`, `Observation`, `Memory`, `Episode`, `Task`, `ContextPacket`, and `ContextEffect` to the approved concepts.
- Identify duplicate ownership between episodes and tasks.
- Identify generic memory routes that bypass task state.
- Freeze the normalized local event schema and repository identity rules.
- Freeze the Context Briefing JSON/rendered format.
- Add a local-only configuration contract: no core path accepts remote source or hosted-index configuration.

### Files

- `src/core/types.ts`
- `src/storage/migrations.ts`
- `src/storage/store.ts`
- `src/task-state/types.ts`
- `src/context/`
- `src/mcp/schemas.ts`
- `src/mcp/tools.ts`
- `src/cli/`

### Tests and proof

- Type-level contract tests for the canonical objects.
- A table/route inventory checked into the implementation notes.
- Configuration test proving the core path is local-only.

### Exit gate

There is one documented owner for task state, observation state, context delivery, and outcome state.

## Phase 1 — durable local evidence

### Work

- Verify all adapters normalize into the same trace/event shape.
- Enforce event idempotency through platform event ID plus content hash.
- Store session, workspace, branch, and commit context with each relevant event.
- Keep capture writes synchronous and enrichment asynchronous.
- Record command exit codes and file operations deterministically.
- Ensure redaction happens before event persistence where required by current policy.
- Make job enqueue happen after the durable transaction.
- Repair any path that advances a watermark or marks processing successful before work completes.

### Files

- `src/capture/raw.ts`
- `src/capture/ingest.ts`
- `src/capture/adapter.ts`
- `src/capture/claude-code.ts`
- `src/capture/codex.ts`
- `src/capture/opencode.ts`
- `src/storage/migrations.ts`
- `src/pipeline/job-queue.ts`
- `src/pipeline/workers.ts`
- `src/pipeline/worker-supervisor.ts`

### Tests and proof

- Duplicate event test.
- Crash between SQLite commit and enqueue.
- Crash during leased job.
- Lease expiry and retry.
- Malformed platform payload.
- Provider unavailable after successful capture.
- Existing database migration and old-schema compatibility.
- Built CLI stdin/hook smoke tests.

### Exit gate

Raw events remain present and unprocessed after enrichment failure, and retries do not duplicate them.

## Phase 2 — make Work Thread the authoritative task model

### Work

- Keep the current `tasks` tables and `TaskStateService` as the owner of task lifecycle.
- Add task detection records for `continue`, `new`, and `uncertain` decisions.
- Link source events, sessions, observations, attempts, and outcomes to the selected Work Thread.
- Add task confidence and task-detection evidence links.
- Define transition rules for `candidate`, `active`, `blocked`, `completed`, and `abandoned`.
- Make requirement, decision, failure, checkpoint, and verification evidence part of the Work Thread view.
- Treat existing episodes as compatibility projections or references; do not let them own separate lifecycle state.

### Detection algorithm

Start deterministic:

- repository/workspace equality;
- branch and commit continuity;
- session continuity;
- file overlap;
- command and error overlap;
- recent activity;
- normalized prompt term overlap.

Then optionally call an LLM only for ambiguous candidates. Persist the chosen decision, score breakdown, and evidence IDs.

### Files

- `src/task-state/types.ts`
- `src/task-state/service.ts`
- `src/task-state/resume.ts`
- `src/task-state/checkpoints.ts`
- `src/storage/migrations.ts`
- `src/core/types.ts`
- new focused module under `src/task-state/` for task detection.

### Tests and proof

- Same-task continuation across sessions.
- New task in the same repository.
- Same words but different repository.
- Shared file but different objective.
- Ambiguous task remains unassigned.
- Branch switch and commit drift.
- Optimistic task-version conflict.
- Completion blocked without evidence.

### Exit gate

A multi-session local bug-fix trace produces one correct Work Thread, while a second unrelated task remains separate.

## Phase 3 — typed observations and provenance

### Work

- Replace broad memory classification in the active path with requirement, decision, discovery, attempt, failure, warning, and verification.
- Keep deterministic evidence separate from LLM-derived observations.
- Define a strict provider schema with evidence IDs, task ID, type, claim, confidence, files, and optional reason.
- Validate provider output before storage.
- Persist many-to-many observation-to-event links rather than only JSON arrays where possible.
- Implement rejection/quarantine for malformed or unsupported output.
- Add conflict and supersession transitions.
- Keep raw events and rejected outputs inspectable locally.

### Files

- `src/observer/schemas.ts`
- `src/observer/parser.ts`
- `src/observer/prompts.ts`
- `src/observer/pipeline.ts`
- `src/observer/provider.ts`
- `src/synth/`
- `src/storage/migrations.ts`
- `src/storage/store.ts`
- `src/lifecycle/`

### Tests and proof

- Valid structured output.
- Unknown evidence ID.
- Cross-repository evidence.
- Malformed JSON.
- Missing required field.
- Duplicate synthesis retry.
- Contradiction and supersession.
- Deleted or stale observation excluded from active retrieval.

### Exit gate

Every derived claim shown to an agent can be traced to valid local source evidence.

## Phase 4 — freshness-aware retrieval

### Work

- Route retrieval through the active Work Thread first.
- Add hard repository, workspace, lifecycle, and provenance filters before ranking.
- Index typed observations, attempts, failures, requirements, decisions, verification, and local evidence in FTS5.
- Preserve file, command, error, branch, and commit fields as structured ranking inputs.
- Validate referenced file existence and current content/hash before selection.
- Mark candidates `current`, `changed`, `stale`, `conflicted`, or `unverifiable`.
- Use FTS5/BM25 as the default path.
- Keep local embeddings optional and fallback-safe.
- Record selected and rejected candidates with score breakdowns and reasons.

### Ranking order

```text
task match
→ exact file/error/command match
→ freshness
→ file overlap
→ previous outcome value
→ confidence
→ recency
```

### Files

- `src/retrieval/eligibility.ts`
- `src/retrieval/fts.ts`
- `src/retrieval/ranking.ts`
- `src/retrieval/hybrid.ts`
- `src/retrieval/vector.ts`
- `src/retrieval/embeddings.ts`
- `src/context/compiler.ts`
- `src/context/builder.ts`
- `src/storage/documents.ts`

### Tests and proof

- Required decision retrieved.
- Failed attempt retrieved for the same error.
- Unrelated repository excluded.
- Stale file claim excluded or qualified.
- Conflicting claims surfaced.
- No-embedding fallback.
- Token budget respected.
- Candidate rejection reasons persisted.
- Retrieval latency measured on a realistic local corpus.

### Exit gate

The briefing covers required task needs while minimizing irrelevant, stale, and unsupported claims.

## Phase 5 — Context Briefing and delivery

### Work

- Define one Context Briefing compiler and remove competing render paths from the active flow.
- Use current Work Thread as the primary query and scope.
- Render task, state, requirements, decisions, attempts, failures, files, verification, open questions, and sources.
- Enforce a 1,200–1,500 token default budget.
- Support empty and review-required states.
- Persist packet, injection, selected candidates, rejected candidates, and latency.
- Deliver at session/task start.
- Deliver file-specific context before relevant reads where the hook surface supports it.
- Keep explicit CLI/MCP search for deeper inspection.

### Files

- `src/context/builder.ts`
- `src/context/compiler.ts`
- `src/cli/handlers/context.ts`
- `src/cli/handlers/file-context.ts`
- `src/mcp/tools.ts`
- `src/mcp/server.ts`
- `src/experience/context-attribution.ts`

### Tests and proof

- Correct packet for active Work Thread.
- Empty packet when no supported context exists.
- Review-required packet for ambiguity/conflict.
- Exact source IDs on claims.
- Session-start delivery.
- File-context delivery.
- MCP/CLI output compatibility.
- Built-package delivery test.

### Exit gate

An agent receives a small explainable briefing at the moment it starts or resumes local work.

## Phase 6 — outcomes and lifecycle feedback

### Work

- Attribute post-delivery commands, tests, builds, files, diffs, and user corrections to the injection and Work Thread.
- Make verification evidence update requirements and steps.
- Close tasks only through evidence or explicit confirmation.
- Keep failed approaches retrievable as warnings.
- Record context effects as used, helpful, harmful, ignored, or corrected.
- Use feedback only for simple ranking adjustments at first.
- Ensure stale, conflicted, superseded, and deleted states propagate to indexes and delivery.

### Files

- `src/experience/recorder.ts`
- `src/experience/context-attribution.ts`
- `src/lifecycle/feedback.ts`
- `src/lifecycle/decay.ts`
- `src/lifecycle/dedupe.ts`
- `src/task-state/service.ts`
- `src/storage/store.ts`

### Tests and proof

- Passed test satisfies a requirement.
- Failed test leaves task incomplete.
- User correction creates replacement evidence.
- Harmful context is excluded from automatic delivery.
- Deleted context disappears from FTS and vector indexes.
- Repeated outcome recording is idempotent.

### Exit gate

Termyte can show whether a delivered context item influenced a recorded local outcome without claiming causality it cannot prove.

## Phase 7 — simplification and removal

Only after the new path has tests and compatibility coverage:

- Remove unused generic memory routes from the core path.
- Collapse duplicate episode/task ownership.
- Remove hosted/external integration assumptions from local startup and help text.
- Keep optional embeddings behind a clear capability boundary.
- Remove dead or unreferenced tables after migration and export checks.
- Keep compatibility aliases only when they do not create separate state.
- Update README, `OVERVIEW.md`, `llms.txt`, CLI help, MCP descriptions, and docs to use Work Thread language.

### Exit gate

A new contributor can trace one product path from hook to briefing to outcome.

## Phase 8 — product proof

### Component evaluation

Run separately:

- durability and fault injection;
- task continuation/new-task/uncertain classification;
- provenance and malformed-output handling;
- lifecycle and stale/conflict behavior;
- retrieval precision, recall, abstention, and token efficiency;
- packaging and installed hook behavior.

### Controlled agent evaluation

Use paired fresh sessions on fixed local repository snapshots:

- baseline: normal repository search;
- treatment: same agent plus Termyte briefing.

Measure:

- task completion;
- median time and tokens;
- time to first correct action;
- repeated failed attempts;
- stale-context mistakes;
- required-context coverage;
- irrelevant-token rate;
- context corrections;
- abstention quality;
- spread across repeated trials.

Do not claim agent improvement from retrieval metrics alone.

## Implementation order and commits

Use small coherent commits in this order:

1. Contract and repository map.
2. Evidence durability and job recovery.
3. Work Thread authority and detection.
4. Typed observation/provenance pipeline.
5. Freshness-aware retrieval.
6. Context Briefing delivery.
7. Outcome attribution and lifecycle.
8. Simplification/removal and docs.
9. Evaluation report and release gate.

Each commit must pass the narrow relevant tests. The final phase runs `npm run verify` plus built CLI, hook, MCP, and benchmark smoke tests.

## Open decision

Choose one synthesis mode before Phase 3:

- **Provider-capable local product:** local storage and integrations, with the existing configured provider interface for synthesis.
- **Strict offline product:** deterministic extraction plus an installed local model only; no network-dependent provider path.

The storage, provenance, task, retrieval, and evaluation design is unchanged by this choice. Only synthesis runtime, installation, and quality expectations differ.
