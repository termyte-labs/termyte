# Task Context Evaluation Design

## Goal

Before changing Termyte's context compiler, measure whether a selected packet contains the evidence a coding agent needs for one explicit task and excludes unsafe or irrelevant evidence.

This is the first implementation slice of the approved task-conditioned context-plane plan.

## Current system

Termyte already has a benchmark runner, dataset parser, adapters, query-level output, and retrieval metrics. Those metrics measure document recall and rank. They do not measure required task needs, forbidden claims, conflicts, packet safety, or irrelevant tokens.

## Approaches considered

1. Extend the current benchmark types with many optional task fields. This is the smallest file change, but mixes document retrieval and packet evaluation into one unclear schema.
2. Add a task-context track beside the existing benchmark tracks. This reuses the runner's output conventions while keeping task-level labels and metrics separate. **Selected.**
3. Build a new evaluation application and database. This adds infrastructure before evidence and is rejected.

## Scope

The first slice adds:

- A versioned JSON schema for task cases, needs, claims, expected packet state, conflicts, and labels.
- A deterministic scorer that compares an actual packet result with the labels.
- Aggregate metrics for required-need coverage, selected-claim precision, forbidden inclusion, conflict recall, correct abstention, unsafe delivery, irrelevant-token rate, and determinism.
- Parser validation and unit tests.
- Twenty labeled cases across at least two repository scopes.
- A small command or script that writes machine-readable results and a short Markdown report.

It does not add packet selection, model calls, SQLite tables, CLI delivery, Viewer pages, or automatic injection.

## Data model

Each case contains:

- Stable case ID and repository scope.
- Explicit task title and objective.
- Required and optional needs with stable IDs.
- Candidate atomic claims with source references, token counts, and labels: `required`, `useful`, `irrelevant`, or `forbidden`.
- Expected conflicts as unordered claim-ID pairs.
- Expected packet state: `ready`, `review_required`, `empty`, or `abstained`.
- One or more fixture packet results used to prove the scorer.

Raw source text stays in the fixture. Labels are separate from candidate metadata so the evaluated selector cannot read its answer key.

## Scoring rules

- Required-need coverage: required needs supported by selected required claims divided by all required needs.
- Selected-claim precision: selected `required` or `useful` claims divided by all selected claims.
- Forbidden inclusion: count of selected forbidden claims.
- Conflict recall: expected conflicts reported divided by expected conflicts.
- Correct abstention: exact match for `empty` or `abstained`; otherwise the expected deliver/block class must match.
- Unsafe delivery: a result marked deliverable when the expected state blocks delivery.
- Irrelevant-token rate: tokens from selected irrelevant claims divided by all selected claim tokens.
- Determinism: repeated results for the same case have the same normalized decision signature.

Zero denominators have explicit behavior: no required needs means full coverage; no expected conflicts means full conflict recall; no selected tokens means zero irrelevant-token rate.

## Validation and errors

Reject duplicate IDs, unknown claim or need references, overlapping labels, invalid conflict pairs, negative token counts, missing source references, and answer labels embedded inside candidate metadata. Errors name the case and invalid field.

The scorer is pure: it reads parsed objects and returns results without file, database, network, model, or clock access.

## Tests

- Parser accepts the checked-in corpus and rejects each invalid reference class.
- Metric tests cover perfect, partial, empty, abstained, unsafe, forbidden, conflicting, and irrelevant-token cases.
- Input order does not change the decision signature or aggregate metrics.
- A regression test runs all twenty cases and checks the report shape.
- Existing retrieval benchmark tests remain unchanged and passing.

## Acceptance criteria

- The corpus contains twenty non-placeholder cases across at least two repository scopes.
- Every metric is derived only from explicit labels and packet results.
- The scorer is deterministic and has no provider dependency.
- Existing `retrieval` and `pipeline` benchmark behavior does not change.
- Typecheck, build, benchmark tests, and the full existing test suite pass.

## Deferred

Real selector quality cannot be claimed from scorer fixtures. After this slice, the side-by-side packet compiler will produce the actual results evaluated by this corpus. Automatic delivery remains off until the larger release gates pass.
