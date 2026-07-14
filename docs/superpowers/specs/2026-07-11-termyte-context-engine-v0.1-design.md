# Termyte Context Engine v0.1

Date: 2026-07-14
Status: Approved implementation design

## 1. Product decision

Termyte v0.1 is a local-first context compiler for Claude Code and Codex. It captures repository work, turns durable evidence into reusable memory, and supplies the smallest evidence-backed context packet that is relevant to the next coding task.

The wedge is not generic long-term chat memory. It is repository-specific experience with inspectable provenance:

- what happened in this repository;
- what evidence supports the retained knowledge;
- why an item was included or excluded from a task packet;
- what happened after the packet was delivered.

Outcome association is recorded, but Termyte does not claim that injected context caused an outcome.

## 2. Fixed v0.1 boundary

v0.1 supports:

- Claude Code and Codex only;
- Windows, macOS, and Linux;
- one local SQLite database under `~/.termyte`, repository-scoped by default;
- Git-aware evidence using commits, changed files, diff metadata, commands, tests, builds, errors, and human feedback;
- local FTS5 retrieval with optional embeddings;
- existing authenticated Claude Code or Codex as the recommended synthesis provider;
- an optional OpenAI-compatible provider configured through environment variables;
- one context compilation per user task;
- Viewer as the human inspection and feedback surface.

The public CLI is exactly:

```text
termyte init
termyte viewer
termyte doctor
termyte uninstall
termyte help
```

Hooks, the worker, MCP tools, evaluation commands, and diagnostic entry points may remain internal. Existing public aliases and unreachable command branches are removed rather than maintained as a second product surface.

Explicitly excluded:

- cloud sync, team memory, accounts, and hosted control planes;
- broad document RAG;
- universal agent support;
- graph databases or a knowledge-graph rewrite;
- AST, symbol-graph, or dependency-graph indexing;
- autonomous skill generation;
- learned ranking or reinforcement learning;
- model fine-tuning and agent orchestration;
- causal claims about context effectiveness.

## 3. Current implementation baseline

The existing product is the foundation, not a prototype to replace.

Already implemented and retained:

- redacted trace persistence;
- durable leased jobs, retries, dead letters, and worker lock ownership;
- episodes, evidence, observations, memories, provenance links, and outcomes;
- FTS5, optional vector retrieval, reciprocal-rank fusion, and reranking;
- memory lifecycle, deduplication, decay, feedback, conflicts, and supersession;
- persisted context packets, candidates, and injections;
- Viewer pages for sessions, episodes, evidence, packets, memories, and diagnostics;
- Claude Code and Codex adapters, installers, hooks, MCP tools, and packaged-install coverage.

Measured gaps that this design closes:

1. The main worker performs one agent invocation per trace and another per observation. A batcher exists but is not connected to the durable pipeline, allowing ordinary sessions to create a growing queue.
2. Context ranking applies primarily to memories. Summaries and observations receive fixed token partitions instead of competing as scored candidates.
3. Packet-to-episode-to-outcome links are incomplete, so effectiveness can be associated only partially.
4. Git commit fields exist, but active capture does not consistently populate commit and diff applicability evidence.
5. Corrections can retain provenance from the replaced statement, making the replacement appear better supported than it is.
6. Public CLI aliases contradict the intended five-command product surface.
7. The package currently declares itself as a runtime dependency.
8. The packed-install test passes in isolation but can make the aggregate test runner time out; the evaluation command also reports retrieval and infrastructure failures.

## 4. Trust and data model

Termyte keeps observed evidence separate from derived interpretation.

### Trace

An append-only, redacted agent event containing session, agent, timestamp, working directory, repository, event type, tool data, affected files, and Git state when available. Trace capture must remain non-blocking and fail open.

### Episode

A bounded task containing its initiating prompt, traces, files, commands, validations, response, timing, and outcome. Supported outcomes are `active`, `succeeded`, `failed`, `partial`, `abandoned`, and `unknown`. Unknown is required when evidence does not justify a stronger result.

### Evidence

A normalized observable fact:

- repository commit before and after the task;
- changed file and compact diff metadata;
- normalized command, exit status, and output digest;
- test or build identity and result;
- normalized repository path;
- error signature;
- explicit human correction, acceptance, or rejection.

An agent statement remains distinguishable from executable or human evidence. A passing test proves only the tested behavior.

### Observation and memory

An observation is a structured interpretation of episode evidence. A memory is reusable repository knowledge derived from one or more observations.

v0.1 keeps the implemented memory types: `bugfix`, `convention`, `warning`, `procedure`, and `fact`. Supported lifecycle states are `active`, `stale`, `conflicted`, `superseded`, and `deleted`.

Every memory must have repository scope, applicability evidence, confidence, source observations, source traces, and source episodes where available. Weak, malformed, or unsupported synthesis creates no active memory.

A correction is new human evidence. It may conflict with or supersede an old memory, but it must not inherit evidence that supports only the old statement.

### Context candidate

Every item considered by the compiler is represented as a candidate, including:

- current repository and task state;
- active memories;
- episode previews;
- observations and direct evidence;
- procedures and warnings;
- the latest handoff or unresolved state.

Each candidate records type, token cost, component scores, selection state, and a rejection reason when excluded.

### Packet, injection, and feedback

A context packet persists the task, repository state, agent, budget, selected candidates, rejected candidates, score components, retrieval mode, and creation time.

An injection records the exact delivered packet, session, agent, delivery method, and timestamp. Feedback events are distinct: `shown`, `used`, `ignored`, `helpful`, `harmful`, `downranked`, and `corrected`. `shown` never implies `used` or `helpful`.

## 5. Target architecture

```text
Claude Code / Codex hooks
  -> normalize and redact
  -> persist trace immediately
  -> deterministic episode and evidence updates
  -> enqueue or coalesce episode synthesis
  -> batched observation and memory synthesis
  -> validate provenance and lifecycle
  -> index searchable records

New task
  -> capture task and current Git state
  -> generate typed candidates
  -> filter by repository, lifecycle, and applicability
  -> score all candidate types
  -> deterministically pack to the hard token budget
  -> persist packet and rejection reasons
  -> inject or abstain

Task completion
  -> persist validations and outcome
  -> associate episode, packet, and injection
  -> record explicit feedback
  -> suppress harmful or corrected knowledge
```

No new service, database, queue, graph layer, or dependency is required. The design reuses the existing SQLite schema, durable job queue, batcher, retrieval stack, packet persistence, hooks, and Viewer.

## 6. Runtime and synthesis design

The first engineering priority is bounded background work.

- Capture and deterministic evidence extraction happen without a model call.
- Traces are grouped by episode.
- At most one pending synthesis job exists for an episode and synthesis kind.
- New trace arrival coalesces into that job instead of creating another model invocation.
- Synthesis runs when an episode completes or becomes idle, with a bounded batch size.
- Observation extraction and memory consolidation operate on the episode batch, not each trace independently.
- Retries remain idempotent and use the existing leased queue and dead-letter behavior.
- One worker remains the default until measurements show that concurrency is needed.
- Diagnostics expose pending count, oldest-job age, leased jobs, throughput, retries, and dead letters.

The existing standalone batch path is either reused by the durable worker or removed. Two parallel synthesis architectures are not retained.

Release behavior under unavailable synthesis:

- capture continues;
- deterministic evidence remains queryable;
- context compilation falls back to already indexed records and FTS5;
- agent startup remains fail open;
- diagnostics state the degraded mode.

## 7. Context compiler design

### Inputs

- task text;
- repository identity and root;
- current commit and changed files when available;
- agent and session;
- hard token budget;
- optional active files, errors, tests, symbols, or commands observable from the event.

### Candidate generation

Candidate generation combines exact identifiers, error signatures, test names, paths, commands, sparse search, optional semantic search, active memories, related episodes, observations, evidence, and current task state.

Summaries, observations, and episode previews no longer receive reserved token partitions. They must earn space through the same candidate contract as memories.

### Eligibility and applicability

The compiler excludes by default:

- a different repository or workspace;
- deleted, superseded, conflicted, or inapplicable memories;
- records with broken required provenance;
- commit- or file-scoped knowledge incompatible with current repository state;
- redundant candidates that add no material information.

Stale items may appear only when an exact match makes the risk useful and the stale state is explicit in the rendered packet.

### Ranking and packing

Ranking uses the smallest useful set of deterministic signals already supported by the product:

1. exact path, test, command, symbol, and error matches;
2. sparse and optional semantic relevance;
3. repository and Git applicability;
4. evidence quality and confidence;
5. explicit helpful, harmful, corrected, ignored, or downranked feedback;
6. recency and lifecycle penalties;
7. redundancy and token cost.

After ranking, packing is deterministic and enforces the hard budget. Exact technical matches can outrank vague semantic similarity. If no candidate clears the minimum threshold, the compiler persists an abstaining packet and injects no prior-experience section.

No learned ranker is added in v0.1.

## 8. Outcome association

Each task episode links to the packet and injection used at its start. Completion records commands, validations, changed files, final commit when available, and the strongest supportable outcome.

Termyte may report:

- the packet was shown or used;
- explicit helpful, harmful, ignored, or corrected feedback;
- a later associated success, failure, or partial result;
- efficiency measures such as tokens, turns, tool calls, repeated reads, repeated commands, elapsed time, and validations where observable.

Termyte must not automatically reinforce a memory merely because it was shown before a successful outcome. Harmful and corrected feedback suppresses reuse immediately. Causal product claims require controlled experiments.

## 9. Viewer requirements

Viewer remains the only human management surface. Existing pages are extended rather than replaced.

It must make these questions answerable without SQL or raw JSON:

- Is capture and background processing healthy?
- Which episode produced this memory?
- Which evidence supports it, and is any provenance broken?
- Which packet was used for this task and what happened afterward?
- Why was each candidate selected or rejected?
- Was knowledge excluded because of repository, lifecycle, Git, file, conflict, score, redundancy, or budget?
- Has a correction superseded the old statement cleanly?
- Did the compiler abstain?

Diagnostics add queue age and throughput. Episode detail shows the episode-to-packet-to-outcome chain. Packet detail shows candidate scores and rejection reasons. Memory detail shows applicability, correction chains, feedback, and broken provenance.

## 10. Installation and packaging

Onboarding is:

```text
npm install -g termyte
termyte init
```

`init` detects supported authenticated agents, lets the user select Claude Code, Codex, or both, preserves existing configuration, installs idempotently, and verifies capture plus worker health. No account or API key is required when an authenticated supported agent is available.

The package must not depend on itself. Installation and uninstall preserve unrelated agent configuration. Database deletion remains explicit rather than implicit during uninstall.

## 11. Non-functional requirements

- Node.js 20 or newer, strict TypeScript, ESM, and NodeNext;
- SQLite WAL and foreign keys;
- redaction before persistence and outbound calls;
- no hook-side model call or synchronous model download;
- hook latency below 150 ms excluding detached work;
- local FTS-only context construction below 500 ms at the release corpus size;
- durable leased jobs with bounded retries and dead letters;
- strict token-budget enforcement;
- provenance for every derived record;
- no telemetry by default;
- visible migrations, compatibility guards, export, and deletion;
- no silent durable-work failure.

## 12. Verification and release gates

All gates must pass from a clean packed installation, not only the repository checkout.

### Reliability

- typecheck and build pass;
- unit and integration tests pass without aggregate runner RPC timeouts;
- packed install, `init`, `doctor`, capture, worker restart, recovery, Viewer, and uninstall pass;
- one real Claude Code session and one real Codex session complete end to end;
- malformed hook input and unavailable synthesis fail open;
- every active memory has valid provenance;
- lifecycle and repository exclusions are enforced;
- every packet respects its hard token budget;
- the queue remains bounded during a replay of at least 100 representative tool events and drains afterward;
- diagnostics expose backlog age, throughput, retries, and dead letters accurately.

### Retrieval and abstention

- the maintained retrieval corpus reaches Recall@5 of at least 0.90;
- exact path, error, test, and command matches beat vague semantic matches;
- harmful, corrected, deleted, conflicted, superseded, and wrong-repository items do not regress into packets;
- at least one adversarial no-match case produces a correct abstention;
- the benchmark loader and fixtures agree on one documented input shape.

### Product evidence

- run at least 20 paired coding trials with Termyte on and off across repeated repository tasks;
- grade task outcome with deterministic checks first and transcript review second;
- record context tokens, turns, tool calls, elapsed time, validations, and failures where observable;
- run repeated trials for nondeterministic agents and report association separately from causation;
- inspect every harmful-context regression before release.

The trial count is a product-learning gate, not a statistically significant performance claim.

## 13. Definition of done

Termyte v0.1 is done when an external developer can:

1. install it and initialize Claude Code, Codex, or both;
2. complete a real coding task without Termyte blocking the agent;
3. inspect the coherent episode, evidence, queue state, and derived memories;
4. start a related task and receive a bounded, relevant packet or a correct abstention;
5. inspect every selected and rejected candidate;
6. trace the packet through injection to the associated task outcome;
7. provide helpful, harmful, ignored, or corrected feedback;
8. verify that unsafe or obsolete knowledge is suppressed;
9. continue in degraded FTS or capture-only operation;
10. export data, uninstall integrations, and explicitly delete local data.

Anything beyond this contract waits for evidence that the v0.1 wedge is used and improves repeated repository work.
