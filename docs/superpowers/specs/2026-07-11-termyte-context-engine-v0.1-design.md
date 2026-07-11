# Termyte Context Engine v0.1

Date: 2026-07-11
Status: Approved product design

## Product definition

Termyte is a local-first context engine for coding agents. It observes coding-agent work, converts durable evidence into repository knowledge and experience, and constructs a compact, task-specific context packet for future sessions.

Its primary job is to select the smallest set of trustworthy prior context likely to help with a coding task in the current repository state. Its secondary job is to let developers inspect what was selected, why it was selected, and what evidence supports it.

The initial users are technical founders and developers who use Claude Code or Codex repeatedly against the same repositories.

## Product boundaries

Required for v0.1:

- reliable Claude Code and Codex integration;
- Windows, macOS, and Linux packaging;
- Git repository awareness;
- local SQLite storage;
- an OpenAI-compatible endpoint for derived memory formation;
- offline FTS retrieval when embeddings are unavailable;
- local inspection and diagnostics.

Experimental integrations are not part of the v0.1 reliability claim. The release does not include cloud collaboration, broad document RAG, organization accounts, autonomous skill generation, model fine-tuning, agent orchestration, enterprise governance, or a universal memory protocol.

## Knowledge and trust model

Termyte keeps observed evidence separate from derived interpretation.

### Agent event

An append-only normalized interaction containing session, agent, timestamp, working directory, repository, commit when available, event type, tool data, and affected files. It is redacted before persistence and always retains provenance.

### Episode

A bounded unit of work that groups events into a task with start and end times, files, commands, validations, responses, and an outcome of `active`, `succeeded`, `failed`, `partial`, `abandoned`, or `unknown`.

An episode records what happened. It does not state what should be remembered.

### Evidence

A normalized observable result such as a command, test, build, diff, file observation, human feedback, or agent statement. Trust remains scoped:

- command output proves only that the command produced the output;
- a passing test proves only the tested behavior;
- an agent statement is never treated as verified evidence;
- explicit human acceptance is evidence, not universal truth.

### Memory

A fallible, reusable statement derived from episodes and evidence. Supported types are fact, decision, convention, warning, and procedure. Every memory has repository scope, applicability conditions, confidence, lifecycle, source episode IDs, and source evidence IDs.

Lifecycle states are candidate, active, stale, conflicted, superseded, and deleted. Weak self-reflection remains a candidate. Corrections create conflict or supersession rather than silently replacing history.

### Context candidate

A current-state item, repository fact, episode preview, memory, procedure, or evidence item considered for a packet. Each candidate records token cost, component scores, selection state, and a rejection reason when excluded.

### Context packet

A persisted, token-bounded artifact containing current state, repository knowledge, relevant experience, procedures, and uncertainties. It records the task, repository, agent, token budget, selected candidates, rejected candidates, and creation time.

### Injection and outcome

Every delivered packet has an injection identity, delivery method, session, agent, and timestamp. A later outcome can be associated with that injection and can record explicit human feedback. Association does not imply causation.

## End-to-end behavior

### After agent activity

```text
Agent event
  -> normalize
  -> redact
  -> persist
  -> assign to episode
  -> extract observable evidence
  -> determine episode outcome when supported
  -> derive candidate memories
  -> validate structure and provenance
  -> index memory and evidence
```

### Before a new task

```text
Task + repository + agent + token budget
  -> resolve repository state
  -> construct lexical and structural query
  -> retrieve scoped candidates
  -> optionally retrieve semantic candidates
  -> apply lifecycle and applicability filters
  -> score and reject weak, stale, or conflicting items
  -> pack within the token budget
  -> persist packet and injection
  -> deliver context
```

### After the task

```text
Evidence + outcome
  -> associate with injection
  -> record explicit feedback
  -> update bounded utility signals
  -> reinforce, stale, conflict, or supersede memory
```

Termyte never makes an automatic causal claim from this association.

## Required features

### Reliable capture

- one-command, idempotent Claude Code and Codex installation;
- preservation of existing agent configuration;
- payload validation and redaction before persistence;
- hook latency target below 150 ms excluding detached work;
- fail-open agent behavior;
- durable, non-blocking background processing;
- local exposure of capture and worker failures.

A clean external installation must capture a real session and survive malformed input, worker restart, and unavailable enrichment.

### Episode construction

Termyte groups events into coherent episodes with an initiating task, timing, files, commands, validations, response, outcome, and links to raw events. Unknown is required when the evidence does not support a stronger outcome.

### Evidence extraction

Termyte normalizes commands and exit status, tests, builds, error signatures, paths and symbols where observable, modified-file or diff metadata, and human feedback. Agent statements remain distinguishable from executable evidence.

### Memory formation

- structured schema validation;
- required repository, episode, and evidence provenance;
- explicit applicability and confidence;
- candidate state for weak verification;
- idempotent retry behavior;
- conflict and supersession for corrections;
- no memory when an episode contains no reusable knowledge.

Every active memory must have valid provenance. Malformed or unsupported model output creates no memory.

### Context compilation

Context compilation is the differentiating runtime.

Inputs include task, repository, commit, agent, token budget, and optional files, errors, tests, or symbols. Candidate generation uses exact identifiers, error signatures, test names, paths, symbols, commands, sparse search, semantic search, related episodes, active memories, and current task state.

Selection applies, in order:

1. repository and workspace eligibility;
2. lifecycle eligibility;
3. commit compatibility;
4. exact lexical and structural signals;
5. semantic similarity;
6. confidence and evidence quality;
7. prior explicit utility;
8. token cost;
9. diversity and redundancy;
10. conflict and stale penalties.

The compiler must enforce a strict token budget, provide deterministic packing after ranking, limit experience items, preserve a no-context outcome, record rejection reasons, support FTS-only fallback, and clearly distinguish facts, experience, procedures, and uncertainty.

Wrong-repository and conflicted or deleted memories are excluded by default. Exact technical matches can outrank vague semantic similarity. Weak candidates produce no prior-experience context.

### Context delivery

Claude Code and Codex hooks are the required delivery paths. MCP and a shared Markdown file are fallbacks. Every delivery records its exact packet and injection identity. Missing context never prevents the agent from starting, and delivery never silently claims success.

### Context debugger

The local debugger provides:

- sessions: agent, repository, task, status, timing, and event count;
- episodes: progress timeline, files, commands, validations, outcome, memories, and evidence;
- context packets: token use, selected items, selection reasons, evidence, rejected candidates, and uncertainty;
- memories: type, content, applicability, lifecycle, confidence, provenance, use, feedback, and relationships;
- diagnostics: capture, queue, jobs, embeddings, retrieval mode, installation, and redaction summary.

All displayed counts and health fields must come from persisted state. A user must not need SQL or raw JSON to understand what Termyte remembered or injected.

### Explicit feedback and outcomes

Users can mark tasks succeeded, failed, partial, abandoned, or unknown and mark injected context helpful, harmful, irrelevant, or corrected. Feedback is persisted before success is reported and is linked to its injection and memory. Harmful or corrected feedback immediately suppresses or penalizes unsafe reuse. `shown` never means `used`.

### Efficiency reporting

Where observable, Termyte records context tokens, turns, tool calls, file reads, repeated file reads, commands, repeated commands, elapsed time, validations, and human interventions. Packet reports include candidates, selections, rejections, token distribution, retrieval mode, and latency.

Reports use associated language unless a controlled experiment supports causal language.

### Local-first trust

- SQLite and no account by default;
- configurable database path;
- explicit disclosure of external model calls and downloads;
- redaction before persistence and outbound calls;
- export and deletion;
- no telemetry by default;
- migrations and compatibility guards;
- visible health diagnostics.

## Initial CLI surface

```text
termyte install claude-code
termyte install codex
termyte start
termyte doctor
termyte health
termyte sessions
termyte session <id>
termyte episode <id>
termyte context --task "<task>" --budget 2500
termyte context inspect <packet-id>
termyte memories
termyte memory <id>
termyte explain <id>
termyte outcome <episode-id> --status succeeded
termyte feedback <memory-id> --event helpful|harmful|irrelevant|corrected
termyte viewer
termyte export
```

Implementation should reuse existing commands rather than duplicate working surfaces to match conceptual names.

## Non-functional requirements

- Node.js 20 or newer;
- strict TypeScript, ESM, and NodeNext;
- SQLite WAL and foreign keys;
- durable leased jobs with bounded retries and dead-letter state;
- offline FTS fallback;
- context construction target below 500 ms for local FTS-only data;
- no hook-side model call or synchronous model download;
- provenance for every derived record;
- explainable context selection;
- no silent durable-work failures;
- clean packaged installation as a release gate.

## Definition of done

Termyte v0.1 is complete only when an external developer can:

1. install it cleanly;
2. connect Claude Code or Codex;
3. complete a real coding session;
4. inspect a coherent episode and its evidence;
5. begin a related session;
6. receive a bounded context packet;
7. inspect why every packet item was selected;
8. record outcome and context utility;
9. continue using the agent while Termyte is unavailable;
10. export or delete local data.

## Ten-day product gate

The engineering release gate is a fresh-machine install, real Claude Code and Codex sessions, durable capture and processing, bounded explainable context, explicit feedback, fail-open operation, and clean uninstall/data deletion.

Product evidence targets are ten installation attempts, five successful external installs, three users completing at least three real sessions, two returning on another day, one observed behavior change associated with context, one correct abstention, and one concrete efficiency observation. These are learning targets, not statistical performance claims.
