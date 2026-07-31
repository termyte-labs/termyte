# Termyte local Work Thread and Context Briefing

**Status:** Approved design  
**Date:** 2026-07-30  
**Scope:** Simplify and evolve `C:\Users\Palguna\Desktop\termyte` into a completely local context control plane for coding agents.

## 1. Product promise

Termyte reconstructs the active local coding task, gives the coding agent a small evidence-linked briefing, and records whether the work succeeded.

Termyte is not:

- a general personal-memory database;
- a repository wiki generator;
- a hosted knowledge graph;
- a replacement coding agent;
- an external engineering-work tracker;
- a large transcript dump.

The complete evidence boundary is local: coding-agent traces, prompts, tool calls, command results, files, local Git state, tests, builds, and the SQLite database.

## 2. Product loop

```text
local agent hook
  -> immutable source event
  -> deterministic normalization
  -> active Work Thread detection
  -> typed observation or attempt
  -> freshness-checked retrieval
  -> bounded Context Briefing
  -> coding-agent action
  -> command/test/build/diff outcome
  -> updated Work Thread
```

The loop must work when the LLM provider is unavailable. Capture, storage, deterministic evidence extraction, task state, lexical retrieval, and outcome recording remain local and usable. LLM synthesis is an enrichment stage, not a durability dependency.

## 3. Existing code to preserve

The current repository already contains most of the needed primitives:

- `src/capture/`: Claude Code, Codex, OpenCode, raw events, file context, redaction, and ingestion.
- `src/hooks/` and `src/integrations/installers/`: hook protocol and local installation.
- `src/storage/`: SQLite connection, migrations, store, documents, and pipeline state.
- `src/pipeline/`: durable jobs, leases, retries, worker supervision, and memory processing.
- `src/task-state/`: tasks, steps, checkpoints, resume compilation, and handoff state.
- `src/context/`: candidate compilation and context rendering.
- `src/retrieval/`: FTS, optional local vectors, hybrid retrieval, ranking, and eligibility.
- `src/experience/`: local Git state, recording, and context attribution.
- `src/observer/` and `src/synth/`: provider-backed structured interpretation.
- `src/mcp/` and `src/cli/`: local agent-facing tools and CLI surfaces.
- `src/benchmark/` and `src/eval/`: context, retrieval, durability, and outcome evaluation.

The plan is therefore a convergence project. It should reduce duplicate concepts and connect the existing paths before adding new infrastructure.

## 4. Canonical concepts

### 4.1 Source event

An immutable normalized event captured from an agent or local workspace.

Examples:

- session start or end;
- user prompt;
- assistant response;
- tool invocation and result;
- command and exit code;
- file read or modification;
- compaction;
- Git branch, commit, diff, or status snapshot.

Every event has a session, repository identity, timestamp, platform, optional platform event ID, content hash, and provenance metadata. Duplicate platform events must be idempotent.

### 4.2 Work Thread

The authoritative representation of one local coding task.

It contains:

- title and objective;
- repository and workspace root;
- status: `candidate`, `active`, `blocked`, `completed`, or `abandoned`;
- current phase and step;
- requirements;
- decisions;
- attempts and failures;
- files, commands, and commits involved;
- verification evidence;
- latest checkpoint;
- task-detection confidence and source events.

The existing `tasks` family is the starting point. Episodes should not become a second competing task model. If an episode is retained for compatibility, it must reference one Work Thread rather than owning parallel task state.

### 4.3 Observation

A typed interpretation of one or more source events. It is not truth by itself.

The target types are:

- `requirement`: what must be true;
- `decision`: a chosen approach and reason;
- `discovery`: useful local understanding;
- `attempt`: an action taken;
- `failure`: an attempt that did not work;
- `warning`: a reusable risk;
- `verification`: evidence that a requirement passed or failed.

Existing memory types such as `bugfix`, `convention`, `warning`, `procedure`, and `fact` should be migrated or mapped into this task-focused vocabulary. Do not add ontology without a persisted consumer and test.

### 4.4 Context Briefing

A bounded, persisted packet delivered to an agent for one Work Thread.

It contains:

- task and current state;
- active requirements;
- relevant decisions;
- previous attempts and failures;
- current files and local anchors;
- latest verification;
- open questions;
- source IDs for every non-obvious claim.

The default budget is 1,200–1,500 tokens. A packet may be empty or require review when no supported useful context exists.

### 4.5 Outcome

A recorded result of work after context delivery.

Outcome statuses are `succeeded`, `failed`, `partial`, `blocked`, `abandoned`, and `unknown`. Deterministic commands, tests, builds, diffs, commits, and explicit user confirmation are stronger than an agent’s final prose.

## 5. Local architecture

### 5.1 Capture path

Hooks must do only fast work:

1. Read the platform payload.
2. Normalize it to the common event shape.
3. Apply redaction rules.
4. Write the immutable event in SQLite.
5. Enqueue an idempotent background job.
6. Return control to the coding agent.

LLM calls, embeddings, broad scans, and context compilation must not block the active coding command.

### 5.2 Task detection path

Each new prompt and meaningful event is scored against active local Work Threads.

Deterministic signals are evaluated first:

- repository and workspace identity;
- branch and commit continuity;
- session continuity;
- files read or modified;
- commands and error strings;
- explicit task words in the prompt;
- recent Work Thread activity.

An optional local/provider LLM can resolve ambiguous intent, but it must return a strict decision with evidence IDs. The result is one of:

- `continue`: attach to an existing Work Thread;
- `new`: create a candidate or active Work Thread;
- `uncertain`: leave unassigned pending more evidence.

Low-confidence evidence must not be merged into an active task silently.

### 5.3 Deterministic evidence path

Facts that can be read directly from the event remain machine-generated:

- command text and exit code;
- test/build status;
- file paths and operations;
- Git branch, commit, and diff;
- tool success or failure;
- timestamps and session boundaries.

These facts are linked to their source event and Work Thread without LLM rewriting.

### 5.4 Synthesis path

LLM synthesis is used only for interpretation and compression:

- identify objective and requirement;
- classify an observation;
- explain why an attempt failed;
- connect evidence to a requirement;
- decide whether a prompt continues a task.

The provider must return schema-validated JSON. A derived record is rejected or quarantined if:

- an evidence ID does not exist;
- evidence belongs to another repository or task scope;
- required fields are missing;
- the claim is unsupported;
- the provider returns malformed output.

Raw evidence remains usable when synthesis fails.

### 5.5 Retrieval path

Retrieval is staged:

1. Hard scope to the local repository, workspace, lifecycle, and provenance.
2. Prefer the active Work Thread and nearby sessions.
3. Search exact paths, symbols, commands, errors, and task terms.
4. Use FTS5/BM25 for lexical candidates.
5. Use optional local embeddings only for paraphrase candidates.
6. Rank by task match, exact evidence match, freshness, file overlap, outcome value, and recency.
7. Validate local anchors before delivery.
8. Pack a bounded briefing.

Embeddings are candidate recall only. Similarity cannot override repository scope, lifecycle, provenance, conflict, or freshness.

### 5.6 Freshness path

Before selecting an observation or memory, Termyte checks:

- referenced file exists;
- relevant file content or hash has not changed unexpectedly;
- current repository and commit are compatible;
- later evidence did not supersede or contradict it;
- a previous change was not reverted.

State is `current`, `changed`, `stale`, `conflicted`, or `unverifiable`. Only current claims can be shown without a qualifier.

### 5.7 Delivery path

The same context compiler supports three delivery points:

- session/task start: active Work Thread briefing;
- before relevant file work: file-specific decisions, warnings, and failed attempts;
- explicit CLI/MCP call: deeper search and provenance inspection.

Automatic delivery must be small. The agent should open current code from disk rather than treating generated prose as a substitute.

### 5.8 Outcome path

After a packet is delivered, subsequent events are attributed to its injection and Work Thread. Termyte records:

- files changed;
- commands, tests, and builds;
- Git diff and commit;
- user corrections;
- agent completion response;
- requirement verification.

Completion requires passed verification evidence or explicit user confirmation. A final agent message alone cannot close a Work Thread.

## 6. Storage direction

SQLite remains canonical and fully local. Markdown may be generated as an optional human-readable view, but it is not the source of truth.

Storage is grouped as follows:

```text
Evidence:  sessions, traces, prompts, tool_calls, commands, file_changes
Work:      tasks/work_threads, requirements, steps, decisions, attempts, failures
Proof:      checkpoints, verification_evidence, outcomes, transitions
Knowledge:  observations, observation_evidence, lifecycle state
Delivery:   context_packets, candidates, injections, effects
Runtime:    jobs, leases, migrations, health
```

The existing migrations and types already contain many of these tables. The implementation must first inventory actual write/read paths, then remove or alias unused duplicate tables. Schema changes require migrations, compatibility tests for existing databases, and synchronization between types, writes, reads, FTS, and vector indexes.

## 7. Lifecycle rules

- Raw source events are immutable until explicit local deletion.
- Observations without valid evidence cannot become active knowledge.
- New contradictory evidence marks a claim conflicted or superseded; it does not silently overwrite it.
- Stale claims remain explainable but are excluded from automatic delivery.
- Deleted claims disappear from retrieval and indexes while deletion provenance remains auditable.
- Retries are idempotent and do not create duplicate observations, jobs, or context packets.
- Usage feedback changes ranking gradually; it does not rewrite history.

## 8. Failure handling

- Hook or capture failure must not stop the coding agent.
- Provider failure leaves the event durable and retries enrichment later.
- Job leases expire and are reclaimable.
- Failed processing cannot advance a success watermark.
- Malformed provider output is stored as a failed attempt and quarantined.
- FTS5 remains usable when embeddings are unavailable.
- `termyte doctor` reports database, queue, provider, hook, and index health.
- No external integration or network service is required by the product.

## 9. User-facing surfaces

Keep the existing CLI and MCP surfaces, but make them Work Thread centered.

Core commands/tools:

- initialize and install local hooks;
- show active Work Thread;
- create or confirm a Work Thread;
- retrieve the current Context Briefing;
- search local evidence;
- inspect provenance for a claim;
- record verification or correction;
- checkpoint and resume;
- show health and queue state.

Legacy generic memory commands may remain temporarily as compatibility aliases, but new documentation and tests should use Work Thread terminology.

## 10. Implementation phases

### Phase 0: inventory and contracts

- Map every storage table to its actual writer and reader.
- Map all CLI, MCP, hook, worker, synthesis, retrieval, and context routes.
- Identify duplicate concepts: episode versus task, summary versus memory, observation versus generic document.
- Freeze the local-only product contract and event schema.
- Add a contract test that rejects external integration configuration from the core path.

Exit condition: a current code map and no undocumented canonical data path.

### Phase 1: evidence and durability

- Verify event idempotency and content-hash deduplication.
- Ensure hook capture never blocks on synthesis.
- Repair queue retry, lease, and failure watermark behavior.
- Add crash, duplicate, malformed payload, and interrupted worker tests.
- Verify existing SQLite migrations against old and fresh databases.

Exit condition: raw local evidence survives provider failure, duplicate delivery, worker crash, and restart.

### Phase 2: Work Thread convergence

- Make the existing task-state model authoritative.
- Add candidate/continue/uncertain task-detection states.
- Attach sessions, traces, observations, attempts, and outcomes to Work Threads.
- Map or remove competing episode/general-memory ownership.
- Persist task transitions and confidence with source-event links.

Exit condition: a multi-session local bug-fix trace is assigned to one correct Work Thread, while unrelated work remains separate.

### Phase 3: typed synthesis and provenance

- Standardize observation types.
- Define provider JSON schemas and parser rejection behavior.
- Persist observation-to-event evidence links.
- Add contradiction, supersession, stale, and quarantine handling.
- Keep deterministic command, test, build, file, and Git facts separate from LLM claims.

Exit condition: every delivered derived claim can be traced to valid local evidence and malformed output cannot become active knowledge.

### Phase 4: task-aware retrieval and briefing

- Route retrieval by active Work Thread before broad memory search.
- Implement hard local scope and lifecycle filters.
- Rank FTS candidates using task, file, freshness, and outcome signals.
- Keep local embeddings optional and fallback-safe.
- Build the 1,200–1,500 token Context Briefing.
- Persist selected and rejected candidates with reasons.

Exit condition: the briefing contains required prior decisions and failures, excludes stale or unrelated claims, and explains every selected item.

### Phase 5: delivery and outcome attribution

- Deliver briefing at session/task start.
- Add file-specific context delivery.
- Record packet, injection, and candidate IDs.
- Attribute subsequent commands, tests, edits, and user corrections.
- Close Work Threads only from verification evidence or explicit confirmation.

Exit condition: a complete local session proves source event → briefing → action → outcome.

### Phase 6: simplify and remove

- Remove unused generic memory flows after compatibility coverage exists.
- Remove dead vector/graph/hosted assumptions from the core path.
- Keep only one canonical task model and one canonical context compiler.
- Preserve legacy aliases only where they do not create new state.
- Update README, CLI help, MCP descriptions, and product docs to match shipped behavior.

Exit condition: a new contributor can trace the complete product flow without learning competing architectures.

### Phase 7: product proof

- Run durability and lifecycle suites.
- Run task-detection corpus with continue/new/uncertain cases.
- Run context corpus with required, irrelevant, forbidden, stale, and conflicting claims.
- Run paired multi-session coding tasks against repository search baseline.
- Report completion rate, time/tokens, repeated failures, stale mistakes, context precision, context recall, abstention, and spread.

Exit condition: claims are limited to measured local behavior. No claim of agent improvement is made without controlled outcome evidence.

## 11. Definition of done

Termyte is positioned correctly only when all are true:

- local hooks capture durable evidence;
- one Work Thread model owns task continuity;
- raw events never depend on the LLM;
- derived observations have valid provenance;
- retrieval is task-scoped and freshness-aware;
- briefings are bounded and explainable;
- stale, conflicted, and unsupported claims are not silently delivered;
- actions and outcomes are recorded;
- retries, duplicates, crashes, and provider failures are tested;
- local-only behavior is proven from the built CLI/MCP package;
- the agent outcome benchmark shows whether the product helps.

## 12. Non-goals for this plan

Do not add:

- GitHub, Slack, Linear, Jira, or any external connector;
- hosted storage or hosted retrieval;
- a graph database;
- an always-on daemon unless current hook/worker behavior proves it necessary;
- a broad user-profile memory product;
- a Markdown wiki as canonical storage;
- a new ranking model before the lexical/task route is measured;
- automatic claim promotion without provenance and lifecycle tests.

## 13. Product sentence

**Termyte keeps context with the local work: it identifies the active coding task, retrieves only current evidence that can change the next action, and records whether that action worked.**
