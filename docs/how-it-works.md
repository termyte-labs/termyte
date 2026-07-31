# How It Works

Termyte follows a simple runtime path:

1. Claude Code, Codex, or OpenCode emits an event.
2. Termyte normalizes and redacts it, then inserts it into an idempotent event ledger.
3. The same transaction projects prompts, completed tools, commands, and file changes.
4. The session recorder groups traces and attaches task evidence.
5. Completed sessions are queued for durable background processing.
6. A detached `termyte-worker` consolidates the full session into an observation and then derives memories.
7. For an active repository task, authoritative task state is packed before historical memory.
8. Checkpoints record Git state; resume and handoff packets report drift and the immediate next action.
9. Retrieval records injected context, and durable attribution feeds bounded results back into lifecycle and ranking.

Duplicate platform event IDs are ignored. Events without one use a content-based fallback key scoped to the session, event type, and timestamp.

## Sessions, tasks, and observations

A session is the complete captured run of an agent. Task state is authoritative for what the developer is trying to do. At session end, Termyte sends every captured trace from that session to the configured model and stores one evidence-linked observation. Memories are reusable knowledge derived from observations; they are not raw transcripts.

## Observation and Memory Synthesis

The foreground integration only captures and queues work. A detached `termyte-worker` performs semantic processing in the background:

1. Redacted tool traces are grouped and sent to the configured synthesis provider.
2. The provider returns structured observation blocks describing durable technical evidence.
3. Termyte parses and validates those blocks before persistence and links every observation to its source traces.
4. Indexed observations are sent through a second consolidation prompt.
5. The validated result is stored as reusable memories linked to both observations and traces.

In `agent` mode, Termyte invokes an already authenticated coding-agent CLI non-interactively:

- Claude Code: `claude -p`
- Codex: `codex exec`
- OpenCode: `opencode run --format json`

These are isolated one-shot background invocations, not continuations of the active coding session. `api` mode uses an OpenAI-compatible chat endpoint. `capture-only` mode makes no synthesis call, so raw traces remain available but new observations and memories are not formed.

## Storage

The central store is SQLite.

Important tables:

- `traces`
- `prompts`, `tool_calls`, `commands`, `file_changes`
- `tasks`, `task_requirements`, `task_steps`, `task_decisions`, `task_failures`
- `verification_evidence`, `task_step_evidence`, `task_transitions`
- `checkpoints`, `handoffs`
- `jobs`
- `observations`
- `memories`
- `summaries`
- `memory_edges`
- `memory_feedback`
- `context_packets`
- `context_candidates`
- `context_injections`
- `context_injection_items`
- `context_effects`
- `documents`
- `document_embeddings`

## Retrieval

Termyte uses more than one search path:

- FTS5 for keyword matching
- local embeddings for semantic similarity
- sqlite-vec when available
- a fallback scan when the native vector extension is missing
- reciprocal-rank fusion to combine scores

## Attribution

Attribution is deterministic and conservative. Explicit harmful or corrected feedback produces `hurt`; explicit helpful or used feedback plus success produces `helped`; successful applicability overlap with executable evidence may infer lower-confidence help. Missing or ambiguous evidence remains `unknown`. Inferred `unused` does not penalize ranking, and inferred harm is not produced.

This closes the software feedback loop, but it does not prove causality or measured agent improvement. Those claims require a controlled paired-agent trial.
