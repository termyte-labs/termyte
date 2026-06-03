# Termyte Reliability Proof Design

## Goal

Make Termyte able to prove, from a local checkout or packaged install, that the current agent runtime is healthy enough to trust for real coding-agent use.

This pass is not about adding integrations. It is about making the existing local runtime boringly dependable, easy to diagnose, and hard to misrepresent.

## Current State

Termyte currently has:

- `termyte run <agent>` as the primary user-facing runtime command.
- `termyte shell` as the lower-level governed session primitive.
- Runtime profiles for Codex, Claude, Aider, and generic/default sessions.
- Local SQLite ledger, memory, and policy state.
- Policy editing through `termyte policies`.
- Benchmark coverage for 230 command cases.
- Doctor checks for local runtime readiness.

Recent work fixed a nested runtime issue where an inner Termyte session could inherit an older Termyte shim directory and recurse through stale shims. The reliability-proof pass should lock that class of failure down and make similar failures visible before users rely on the product.

## Non-Goals

This pass does not add:

- MCP.
- IDE integration.
- Cloud sync.
- Dashboard.
- Hosted services.
- New policy architecture.
- New memory architecture.
- New agent integrations beyond existing `codex`, `claude`, and `aider` support.

## Reliability Definition

Termyte is reliability-ready when a user can run a short validation sequence and know:

- whether the CLI is installed correctly,
- whether agent binaries are discoverable,
- whether governed subprocess execution works,
- whether nested runtime launch is safe,
- whether policy and database state are loadable,
- whether package assets are present,
- whether recent failures are expected warnings or real blockers.

The output should be concrete. A user should not need to understand shims, daemon IPC, or PATH internals to know what to fix next.

## Architecture

Reliability proof should be built around existing modules:

- `doctor`: owns machine and runtime readiness checks.
- `shell`: owns governed sessions, shims, hooks, executable resolution, and nested runtime behavior.
- `agent`: owns `termyte run` planning, runtime profiles, agent metadata, and dry-run reporting.
- `policy`: owns local policy loading and validation.
- `ledger` and `format`: own proof artifacts through logs and replay.
- `bench`: owns deterministic command-classification coverage.

No separate reliability engine should be introduced. The reliability proof should compose existing primitives and add small, testable checks where gaps exist.

## Workstream 1: Doctor As The Trust Command

`termyte doctor` should become the main command for proving local runtime health.

Required checks:

- Node version and executable path.
- npm availability and real npm path.
- git availability and real git path.
- workspace writability.
- `.termyte` directory writability.
- SQLite DB path writability.
- policy state loadability.
- active policy validity.
- Windows `PATH`/`Path` normalization.
- Windows `PATHEXT` includes `.EXE` and `.CMD`.
- shim manifest creation and integrity.
- shim directory inserted first in PATH.
- daemon IPC accepts a local request.
- real shim smoke request executes `node --version`.
- nested session smoke request does not resolve through older Termyte shims.
- stale pending shell-shim rows are detected and summarized.
- packaged benchmark file is discoverable.
- packaged benchmark can run from the installed package layout.
- `codex`, `claude`, and `aider` discovery is reported as pass or warning.

Decision:

- Missing optional agents are warnings, not failures.
- Missing required runtime basics are failures.
- Shell smoke timeout is a failure.
- Stale recovered shim rows are warnings unless they are from the active session.

## Workstream 2: Nested Runtime Hardening

The nested runtime bug should become a permanent regression suite.

Required behavior:

- New sessions strip any older `.termyte/sessions/*/shims` entries from `TERMYTE_ORIGINAL_PATH`.
- New sessions strip `.termyte/preview/shims`.
- `resolveRealExecutable` skips Termyte shim directories, not only the current session shim dir.
- Inner `_shim node --version` resolves the real Node executable.
- A nested `termyte doctor` should not recurse into older shim sessions.
- A hung shim child should fail with a clear timeout outcome instead of staying pending indefinitely.

Testing:

- Unit tests for PATH stripping.
- Unit tests for real executable resolution with Windows `.cmd` behavior.
- Unit tests for timeout outcomes.
- Integration-style doctor test for shim smoke success.

## Workstream 3: Packaged Install Proof

Add a packaged validation path that proves Termyte works outside the checkout layout.

Validation flow:

```bash
npm run build
npm pack
npm install ./termyte-*.tgz --prefix <temp-project>
node <temp-project>/node_modules/termyte/dist/cli.js --help
node <temp-project>/node_modules/termyte/dist/cli.js doctor --json
node <temp-project>/node_modules/termyte/dist/cli.js run --dry-run codex
node <temp-project>/node_modules/termyte/dist/cli.js shell -- node --version
node <temp-project>/node_modules/termyte/dist/cli.js bench --json
```

For automated tests, use a temp project and local package install rather than mutating the user's global npm install.

Required assertions:

- Package includes `dist`.
- Package includes `benchmarks/commands.json`.
- CLI bin resolves to `dist/cli.js`.
- `doctor --json` has no failures in the temp install.
- `bench --json` reports the expected total and zero false negatives.

## Workstream 4: Failure Message Quality

Every reliability failure should answer three questions:

- What failed?
- Why does it matter?
- What should the user try next?

Examples:

- Missing Codex: "codex executable was not found on PATH. Install Codex or update PATH before launching without --dry-run."
- Bad PATHEXT: "PATHEXT does not include .CMD, so Windows command shims may not launch."
- Shim timeout: "Shim smoke request timed out. This usually means the shim resolved another Termyte shim instead of the real executable, or the guard daemon stopped responding."
- DB not writable: "Termyte cannot write local state. Set TERMYTE_DB_PATH to a writable path or fix workspace permissions."
- Stale pending rows: "Previous shim executions were recovered as abandoned. Run doctor again; if new stale rows appear, subprocess finalization is unhealthy."

Decision:

- Keep messages concise in human output.
- Put structured fields and raw evidence in JSON output.

## Workstream 5: Logs And Replay Proof

Logs and replay should make reliability evidence easy to inspect.

Required behavior:

- `termyte run` entries show `launchedVia`, `agentName`, and `runtimeProfile`.
- Replay shows `launched via: termyte-run` where applicable.
- Failed, warned, blocked, and recovered executions remain eligible for memory observation.
- Recovered stale shim rows are visible as recovered failures, not silent cleanup.

No full replay redesign is needed in this pass.

## Workstream 6: Documentation

README and public docs should include a reliability verification section.

Minimum content:

- "How to verify Termyte works on your machine."
- "What a healthy doctor result looks like."
- "Which warnings are acceptable."
- "Which failures mean do not trust the runtime yet."
- Windows-specific PATH/PATHEXT guidance.
- Nested-runtime troubleshooting.
- Packaged install validation.

## Data Flow

1. User runs `termyte doctor`.
2. Doctor creates a governed session.
3. Doctor validates PATH/PATHEXT and shim manifest.
4. Doctor sends a daemon IPC smoke command.
5. Doctor executes a real shim smoke command.
6. Doctor validates policy state and packaged assets.
7. Doctor summarizes optional tool discovery.
8. Doctor returns human or JSON output.
9. Ledger records proof actions where the runtime actually evaluated a command.

## Error Handling

Doctor should classify errors as:

- `PASS`: required behavior works.
- `WARN`: optional capability missing or historical issue detected.
- `FAIL`: required runtime behavior is broken.

Failure output should include:

- stable check id,
- section,
- status,
- short message,
- optional details object in JSON.

The CLI should continue to fail closed for governed execution. Reliability diagnostics should not relax runtime policy.

## Testing Plan

Add or maintain tests for:

- nested shim stripping,
- Windows `.cmd` executable resolution,
- non-interactive `termyte shell -- <command>`,
- agent dry-run missing executable warnings,
- doctor JSON shape and summary,
- doctor optional agent warnings,
- policy loadability and validation,
- benchmark packaged asset discovery,
- replay display of `termyte-run`,
- stale shim recovery visibility,
- packaged install smoke flow.

Expected validation commands:

```bash
npm test
npm run build
node dist/cli.js doctor --json
node dist/cli.js run --dry-run codex
node dist/cli.js run codex --version
node dist/cli.js run --dry-run claude
node dist/cli.js run --dry-run aider
node dist/cli.js shell -- node --version
node dist/cli.js bench --json
node dist/cli.js logs --limit 20
node dist/cli.js replay
```

## Acceptance Criteria

Reliability proof is complete when:

- Full tests pass.
- Build passes.
- Benchmark remains 230/230 with zero false negatives.
- Doctor has zero failures on a normal dev machine.
- Optional missing agents are warnings.
- Nested runtime smoke does not hang or recurse.
- Shell smoke works non-interactively.
- Packaged install validation passes from a temp install.
- README and docs explain reliability verification.
- Known limitations are explicit and not hidden.

## Open Architectural Decisions

These should be decided before implementation:

1. Whether packaged install validation should be a new command, a doctor flag, or a test-only script.
2. Whether stale recovered rows should be shown in doctor by default or only in strict mode.
3. Whether `doctor --strict` should fail on optional missing agents.
4. Whether reliability JSON should remain doctor-specific or become a stable machine-readable contract.

Recommendation:

- Start with doctor improvements and test-only packaged validation.
- Avoid adding `doctor --strict` until there is evidence users need it.
- Treat doctor JSON as stable enough for tests but not yet a public API.
