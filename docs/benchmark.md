# Governance Benchmark

Termyte includes a deterministic local benchmark for the stable, non-executing
policy/check path. The benchmark measures classification behavior; it does not
execute any fixture command.

## Governance Suite

Run:

```bash
npm run build
termyte bench
termyte bench --json
```

The governance fixture contains 1,200 unique actions:

- 400 expected `allow` actions
- 300 expected `warn` actions
- 500 expected `block` actions

Each case has one strict expected decision plus a category, risk class,
platform metadata, tags, source, and rationale. The generator enforces count,
the expected decision distribution, uniqueness, and deterministic ordering.

The suite covers representative read-only commands, tests and validation,
ordinary file reads, blocked package publishing, scoped SQL deletion, privilege
escalation, destructive git history operations, secret access, protected
branch force pushes, destructive SQL, and broad filesystem deletion.

The checked-in 1,200-case suite currently produces 1,200 correct decisions,
zero false-safe results, and zero overblocks. Re-run `termyte bench --json`
against the installed version instead of treating this checked-in result as a
permanent product guarantee.

## Metrics

Termyte reports:

- Overall and per-category accuracy
- Per-decision precision and recall
- Decision confusion matrix
- False positives and false negatives
- False-safe rate
- Overblock rate

False-safe counts expected blocked actions classified below block and expected
warnings classified as allow. Overblock counts expected allows classified as a
stricter decision.

## Compatibility Suite

The original 230-case legacy runtime fixture remains available:

```bash
termyte bench --legacy
```

It measures the older runtime inspection path and permits multiple acceptable
decisions for some cases. Results from the governance and compatibility suites
must not be combined or compared as if they used the same methodology.

## Claim Boundary

The benchmark validates deterministic decisions for its labeled fixtures. It
does not prove that Termyte recognizes every command, prevents every dangerous
action, provides sandbox isolation, or governs commands that bypass Termyte.

Policy or parser behavior must not be changed solely to improve benchmark
scores. Benchmark misses should remain visible until the underlying behavior is
independently justified and tested.
