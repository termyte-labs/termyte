# Six-Week Product and Engineering Sprint Design

Date: 2026-07-04
Status: Approved design

## Objective

Turn Termyte's current memory pipeline into a credible coding-agent experience loop that can attribute recalled knowledge to downstream work, correct harmful or obsolete knowledge from repository evidence, and measure whether memory improves real coding outcomes.

The six-week program consists of three two-week sprints. It prioritizes one coherent vertical product path over feature breadth:

```text
coding event
  -> durable trace
  -> grounded observation
  -> provenance-linked memory
  -> attributed context injection
  -> agent action
  -> test, build, or task outcome
  -> usefulness evidence
  -> ranking adjustment or correction
  -> later retrieval behavior
```

## Product claim under test

The program tests one narrow claim:

> Coding agents using Termyte repeat fewer previously observed mistakes and complete more repository tasks than equivalent agents without persistent experience.

The program must not promote this claim unless the final controlled evaluation supports it.

## Scope principles

1. Complete the smallest end-to-end experience loop before expanding integrations or ontology.
2. Preserve raw traces and provenance through every derived artifact.
3. Treat memory exposure, memory use, and outcome attribution as separate events.
4. Do not treat correlation between an injection and an outcome as causal proof.
5. Prefer deterministic repository evidence and executable tests over model judgment.
6. Report harmful recall, regressions, ambiguity, and failures alongside positive metrics.
7. Keep hooks non-blocking and all durable work retry-safe.

## Current baseline

Implemented foundations:

- platform adapters and hook-based trace capture;
- SQLite traces, observations, memories, documents, feedback, injections, and jobs;
- durable leases, retries, backoff, idempotent subjects, and dead-letter state;
- detached worker supervision;
- trace-to-observation-to-memory provenance;
- FTS and embedding retrieval with lifecycle eligibility;
- typed retrieval and explicit feedback;
- context-injection records;
- correction-job scaffolding;
- 263 passing tests across 37 files and a passing build.

Known blockers:

- summary and decay jobs cannot recur correctly under the current unique job identity;
- file-context retrieval bypasses injection tracking;
- `shown` is automatic, but defensible `used` evidence and automatic outcome attribution are absent;
- feedback, confidence, importance, decay, and usage do not affect ranking;
- correction text is trusted without repository or test verification;
- correction replacements do not traverse the complete normal provenance lifecycle;
- active vector retrieval scans embedding BLOBs;
- secret redaction is incomplete;
- no controlled experiment proves that Termyte improves coding-agent execution.

## Ownership model

Each sprint has one accountable lead. Supporting owners are involved only at explicit interfaces.

| Sprint | Lead | Support |
|---|---|---|
| Sprint 1: Attributable experience | Agent Runtime and Execution Systems | Memory Modeling, Code Intelligence, Evaluation |
| Sprint 2: Evidence-backed correction | Memory Modeling and Knowledge Architecture | Retrieval, Code Intelligence, Runtime, Evaluation |
| Sprint 3: Product proof and hardening | Evaluation and Benchmarking | Runtime, Retrieval, Memory Modeling, Code Intelligence |

The lead owns integration, validation, and the completion report. A supporting subsystem is not a completion boundary.

## Sprint 1: Attributable experience

Duration: Weeks 1-2

### Outcome

Every injected memory used by the supported reference integration can be traced through subsequent agent activity to observable test, build, command, or task outcomes.

### Product behavior

The reference path is one supported coding agent, selected from Claude Code or Codex based on the first successful built-package live smoke test. Other advertised integrations remain supported but are not expanded during this sprint.

For every context injection, Termyte records:

- injection ID;
- repository, workspace, session, and integration surface;
- query and active file context;
- selected memory IDs and retrieval scores;
- time and token-size information;
- subsequent trace IDs within a bounded attribution window;
- explicit or deterministic evidence that a memory was used;
- associated command, test, build, or task outcome events.

### Required components

#### Recurring job identity

Summary and decay work must support multiple generations for the same subject without permitting duplicate concurrent work.

The job identity must distinguish a logical run or generation from the stable subject. Completed historical jobs remain inspectable. Retry remains idempotent within one generation.

#### Universal injection path

All active memory-context surfaces, including file-context handling, must call the same injection-recording boundary. Direct search remains permitted for diagnostics but must not be used for agent-visible memory injection.

#### Attribution window

An attribution record connects an injection to later traces without claiming causality. The policy must define:

- session boundary;
- maximum duration;
- maximum number of downstream traces;
- behavior when multiple injections overlap;
- behavior when no subsequent action occurs.

#### Usage evidence

`shown` means Termyte placed a memory in context. It does not mean the agent used it.

An automatic `used` event requires observable evidence such as:

- the agent cites a provided memory identifier;
- a structured hook payload carries the injection ID;
- an agent action references a distinctive file, command, constraint, or entity supplied by the memory and the match passes a conservative deterministic policy.

Ambiguous evidence is stored separately and cannot reinforce memory.

#### Outcome capture

Normalize downstream evidence into a small initial outcome model:

- `test_passed`;
- `test_failed`;
- `build_passed`;
- `build_failed`;
- `command_succeeded`;
- `command_failed`;
- `task_completed`;
- `task_abandoned`;
- `unknown`.

Raw trace evidence remains the source of truth. Outcome normalization must preserve source trace IDs and parser version.

#### Redaction boundary

Apply deterministic redaction before raw trace persistence and before any external LLM request. Record that redaction occurred without storing the removed secret.

The first corpus must cover common API keys, bearer tokens, private keys, passwords, connection strings, multiline secrets, and encoded variants that can be detected without executing content.

### Failure behavior

- Hook capture remains non-blocking.
- Attribution failure cannot lose the underlying trace.
- Malformed outcome evidence is stored as `unknown`, not promoted to success or failure.
- Duplicate delivery cannot create duplicate injection-event relationships.
- Redaction failure blocks external transmission and records a safe diagnostic.
- A background failure must remain visible through retry or dead-letter state.

### Acceptance criteria

1. Summary and decay jobs can execute more than once for the same subject while duplicate concurrent generations remain prevented.
2. Every agent-visible memory context in the reference integration returns and persists an injection ID.
3. Every recorded use points to an injection, memory, session, and source evidence.
4. Every normalized outcome points to its source traces.
5. Ambiguous usage does not reinforce memory.
6. The secret corpus does not appear in stored traces, logs, rendered context, or external-request fixtures.
7. A clean packaged installation completes the reference trace-to-injection-to-outcome path.

### Validation

- focused unit tests for identity, attribution, usage, outcomes, and redaction;
- retry, duplicate-delivery, overlapping-injection, abandoned-injection, and malformed-payload tests;
- `npm run typecheck`;
- `npm test`;
- `npm run build`;
- clean tarball installation;
- one recorded built-package live integration smoke test with secrets removed.

### Sprint 1 stop/go gate

Do not begin ranking or correction work until one query can reconstruct this complete chain from persisted IDs:

```text
memory -> injection -> downstream trace -> normalized outcome
```

## Sprint 2: Evidence-backed correction

Duration: Weeks 3-4

### Outcome

Termyte can conservatively change retrieval behavior from attributable evidence and can verify, conflict, correct, or supersede knowledge without trusting correction text as truth.

### Product behavior

The sprint introduces two separate decisions:

1. Ranking adjustment: should this eligible memory be more or less likely to appear for the current task?
2. Knowledge correction: does current evidence show that the memory itself is wrong, stale, or inapplicable?

A failed task does not automatically prove that every injected memory was wrong. A successful task does not automatically prove that every shown memory was useful.

### Required components

#### Transparent ranking features

The initial scoring model may use:

- lexical rank;
- vector rank;
- repository and workspace scope;
- file overlap;
- lifecycle eligibility;
- confidence;
- importance;
- decay score;
- verified use count;
- attributable positive and negative outcomes;
- correction or conflict state.

Every returned memory must expose a diagnostic score breakdown. Conservative clamps prevent a small number of feedback events from dominating semantic relevance.

#### Evidence bundle

Verification jobs gather a bounded, immutable evidence bundle containing:

- original memory and provenance;
- source traces and observations;
- correction feedback;
- current repository-relative file evidence;
- relevant commands, tests, stack frames, and diffs when available;
- attributable outcome records;
- retrieval and lifecycle history.

Missing evidence is explicit. It is not replaced by model inference.

#### Verification decision

The correction pipeline produces one of:

- `reinforce`: evidence supports the existing memory;
- `retain`: insufficient evidence to change it;
- `conflict`: credible unresolved evidence disagrees;
- `correct`: evidence supports a replacement claim;
- `supersede`: a newer applicable memory replaces it;
- `invalidate`: deterministic evidence proves it should not be used.

Any model output is untrusted structured input. Deterministic guards validate referenced evidence IDs, repository scope, allowed transitions, and replacement provenance.

#### Correction propagation

A replacement must follow normal memory persistence, provenance linking, embedding, indexing, deduplication, and lifecycle paths. Superseded or invalid memory documents are removed from default retrieval while history remains inspectable.

#### Explainability

`termyte.explain` returns:

- memory content and state;
- source traces and observations;
- selected files and scope;
- incoming and outgoing memory edges;
- injection and feedback history;
- attributable outcomes;
- ranking feature breakdown;
- correction decisions and evidence references.

### Failure behavior

- Insufficient evidence retains or conflicts memory; it never fabricates a replacement.
- Verification retries are idempotent.
- Missing source files do not erase historical provenance.
- Conflicted, superseded, invalid, stale, and deleted memories remain excluded from default retrieval.
- Ranking falls back to FTS when embeddings or feature loading fail.
- A ranking-feature failure cannot silently make an ineligible memory eligible.

### Acceptance criteria

1. Positive and negative evidence changes rank predictably in independently labeled fixtures.
2. Semantic relevance remains the dominant signal unless sufficient attributable evidence exists.
3. Correction text alone cannot activate a replacement memory.
4. Replacement memories preserve complete provenance and enter normal dedupe, embedding, and lifecycle processing.
5. Superseded and invalid memories cannot appear in default retrieval.
6. `termyte.explain` contains no placeholder fields for supported memory records.
7. A live two-session scenario demonstrates that verified correction changes later retrieval.

### Validation

- positive, negative, ambiguous, stale, and harmful-memory ranking corpora;
- score-breakdown and fallback tests;
- correction, insufficient-evidence, conflicting-evidence, retry, and cross-repository tests;
- graph and lifecycle invariant tests;
- latency comparison against the Sprint 1 baseline;
- Tier 2 repository validation;
- built CLI and MCP explain smoke tests.

### Sprint 2 stop/go gate

Do not begin headline evaluation until a deterministic scenario proves:

```text
bad or obsolete memory
  -> attributable contradictory evidence
  -> safe lifecycle decision
  -> corrected later retrieval
```

## Sprint 3: Product proof and hardening

Duration: Weeks 5-6

### Outcome

Produce a reproducible answer to whether Termyte improves coding-agent execution, including negative effects, operational limits, and comparison with credible baselines.

### Evaluation hierarchy

#### Installed-pipeline proof

A clean package installation must execute:

```text
hook payload
  -> trace
  -> worker
  -> observation
  -> memory
  -> context injection
  -> outcome
  -> retrieval update
```

The harness injects controlled failures after durable boundaries and verifies recovery without duplicate state.

#### Public memory benchmark

Adapt one public benchmark that tests incremental learning or agentic memory. Preferred order:

1. MemoryAgentBench for retrieval, test-time learning, long-range understanding, and conflict resolution;
2. MemoryArena for interdependent multi-session action;
3. LongMemEval-V2 for trajectory and workflow memory.

Classic LongMemEval or LoCoMo may be reported for comparability but cannot support a coding-agent usefulness claim.

#### Longitudinal coding-agent benchmark

Construct a controlled set of 20-50 tasks from public repository issues, beginning with a small number of repositories so prior experience can plausibly transfer.

Each condition uses identical:

- repository snapshots;
- task descriptions;
- model and model version;
- agent runtime;
- tools and permissions;
- token and wall-clock budgets;
- environment and test commands.

Treatment order is randomized and repeated where model nondeterminism affects conclusions.

Initial conditions:

- no persistent memory;
- static curated repository notes;
- Termyte;
- one competitor adapter, chosen by reproducible local availability.

Historical experience may include only information available before the evaluated task. Future patches, issue resolutions, and answer-key content are prohibited.

### Metrics

Primary metrics:

- task pass rate using executable tests;
- repeated-error rate;
- harmful-memory use;
- regression or unrelated-edit rate.

Secondary metrics:

- tokens;
- tool calls;
- wall-clock time;
- cost;
- retrieval precision and recall;
- injection attribution coverage;
- correction success and latency;
- worker retries and dead letters;
- p50, p95, and p99 retrieval latency;
- process memory use.

Report sample size, raw failures, median, spread, exclusions, and model-judge use. Do not publish averages without the underlying trial records.

### Scale decision

Measure active vector-scan behavior at realistic corpus sizes. Wire sqlite-vec during this sprint only if measured latency or memory exceeds the documented product target. The benchmark result, not the existence of scaffolded code, controls the decision.

### Failure behavior

- Failed trials remain in raw results unless excluded by a predefined infrastructure rule.
- Infrastructure failure and agent task failure are reported separately.
- A negative or neutral Termyte result is reported without weakening thresholds.
- Competitor failures caused by adapter setup are not counted as product failures.
- Evaluation state is isolated between conditions except for the explicitly persisted prior experience.

### Acceptance criteria

1. Clean-install end-to-end execution passes with crash and retry injection.
2. The public benchmark adapter produces reproducible raw and aggregate results.
3. At least 20 longitudinal coding-task trials complete across all required conditions; 50 is the target if cost and runtime permit.
4. No expected answer, future patch, or gold keyword enters indexed memory.
5. The report includes harmful recall, failures, variance, and exclusions.
6. Supported corpus and concurrency limits are documented from measurements.
7. README and product claims are updated only to the narrowest result supported by the evidence.

### Validation

- reproducibility rerun of a fixed subset;
- answer-leakage and mutable-state audit;
- clean-environment package and integration test;
- concurrency and fault-injection suite;
- full repository Tier 3 validation;
- blinded review of residual non-deterministic judgments.

### Sprint 3 completion gate

The program completes only when a versioned report answers:

1. Does Termyte improve task success?
2. Does it reduce repeated mistakes?
3. Does it introduce harmful anchoring or regressions?
4. What does it cost in tokens, latency, and process resources?
5. Under which repositories, tasks, and agent conditions do the results apply?

## Weekly milestones

| Week | Milestone | Observable proof |
|---|---|---|
| 1 | Unified injection and recurring-job foundation | Repeated summary/decay run and all reference contexts return injection IDs |
| 2 | Outcome attribution and redaction | Persisted memory-to-injection-to-trace-to-outcome chain from a clean install |
| 3 | Feedback-aware transparent ranking | Independent fixtures show bounded positive and negative rank movement |
| 4 | Evidence-backed correction | Two-session scenario corrects later retrieval with complete provenance |
| 5 | Installed and public benchmark harnesses | Reproducible pipeline and selected public benchmark results |
| 6 | Longitudinal coding trials and report | Raw trials, aggregate metrics, limits, and truthful product claims |

## Explicit exclusions

The program does not include:

- new coding-agent integrations beyond the selected reference integration;
- hosted synchronization or multi-device memory;
- team collaboration and tenancy;
- billing, fundraising, revenue, or marketing work;
- a general-purpose memory-provider SDK;
- dashboards beyond diagnostics required to inspect the loop;
- new memory ontologies without an evaluation-backed requirement;
- feature-count parity with Mem0 or AgentMemory;
- major external services or a new top-level subsystem.

## Program success criteria

At the end of six weeks, the product must satisfy both engineering and evidence conditions.

Engineering success:

- complete attributable experience loop;
- evidence-constrained correction;
- feedback-aware retrieval;
- redaction and durable failure handling;
- clean installed reference integration.

Evidence success:

- reproducible public memory benchmark;
- controlled longitudinal coding-agent trials;
- explicit harmful-recall measurement;
- honest result report with raw failures and applicability limits.

If the experiment shows no improvement, the engineering program is still complete, but the product hypothesis is not validated. The next plan must respond to the observed failure modes rather than expanding the feature surface.
