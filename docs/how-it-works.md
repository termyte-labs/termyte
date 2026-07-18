# How It Works

Termyte follows a simple runtime path:

1. Claude Code, Codex, or OpenCode emits an event.
2. Termyte normalizes and redacts it, then inserts it into an idempotent event ledger.
3. The same transaction projects prompts, completed tools, commands, and file changes.
4. The recorder groups traces into task episodes and attaches observable evidence.
5. The trace is queued for durable background processing.
6. A detached `termyte-worker` extracts observations and consolidates memories.
7. For an active repository task, authoritative task state is packed before historical memory.
8. Checkpoints record Git state; resume and handoff packets report drift and the immediate next action.
9. Retrieval records injected context, and durable attribution feeds bounded results back into lifecycle and ranking.

Duplicate platform event IDs are ignored. Events without one use a content-based fallback key scoped to the session, event type, and timestamp.

## Episodes and Experience

An episode is a coherent unit of coding work. Ordinary follow-up prompts remain in the active episode. A failed command, test, or build, or an explicit new-task prompt, starts a new episode so the failed attempt and its resolution remain distinguishable.

Experience is the combination of an episode, its evidence, and its outcome. Memories are reusable knowledge derived from that experience; they are not raw transcripts.

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

This closes the software feedback loop, but it does not prove causality or measured agent improvement. Those claims require the paired Claude Code/Codex protocol in `docs/evals/context-v0.1-trial-protocol.md`.
