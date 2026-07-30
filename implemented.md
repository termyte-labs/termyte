# Termyte implementation progress

## 2026-07-31

- Phase 0: mapped the current capture, episode, task-state, storage, retrieval, context, and outcome paths.
- Confirmed the existing `tasks` tables and `TaskStateService` are the current task owner; episodes remain a compatibility projection until linked.
- Confirmed raw trace persistence is synchronous and idempotent before observer work is queued.
- Baseline verification: `npm run typecheck` passes.

- Commit `35590f2`: added deterministic Work Thread detection with `continue`, `new`, and `uncertain` decisions.
- Added persisted task detections, task memberships, task activity metadata, and episode-to-task links.
- Hook processing now assigns each new trace to the detected local Work Thread before episode recording.
- Added coverage for first-task creation and same-task continuation.
- Verification: `npm run typecheck`; focused task, hook, and experience tests pass.

- Commit `d74ffad`: added typed Work Thread observations with strict Zod validation and trace provenance.
- Added lifecycle states (`active`, `stale`, `superseded`, `conflicted`, `deleted`, `quarantined`) and many-to-many observation/evidence links.
- Invalid or unsupported evidence is rejected before storage; raw traces remain unchanged.
- Verification: `npm run typecheck` and focused observation tests pass.

- Commit `f61362c`: Context Briefings now include active, provenance-linked Work Thread observations.
- Added a 1,500-token default briefing budget when callers do not set one; explicit caller budgets remain unchanged.
- Stale, superseded, conflicted, deleted, and quarantined Work Thread observations are excluded by the observation store.
- Verification: typecheck and focused context/compiler/runtime-gate tests pass.

- Commit `36853fe`: explicit `new`, `another`, `separate`, `switch`, and `next` task prompts now force a new Work Thread.
- Reduced continuity weights so shared repository/session context without file or prompt evidence remains `uncertain` instead of silently merging.
- Verification: typecheck and focused detection/hook tests pass.
