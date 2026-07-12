# How It Works

Termyte follows a simple runtime path:

1. A supported agent emits a normalized event.
2. Termyte redacts obvious secrets and stores the event as a trace.
3. The recorder groups traces into task episodes and attaches observable evidence.
4. The trace is queued for durable background processing.
5. A detached `termyte-worker` claims the job and extracts observations.
6. Observations are consolidated into reusable memories.
7. Memories are embedded, indexed, and made searchable.
8. Retrieval builds compact context cards, records what was injected, and exposes explicit detail lookup.
9. Feedback is stored and can influence later ranking.

## Episodes and Experience

An episode is a coherent unit of coding work. Ordinary follow-up prompts remain in the active episode. A failed command, test, or build, or an explicit new-task prompt, starts a new episode so the failed attempt and its resolution remain distinguishable.

Experience is the combination of an episode, its evidence, and its outcome. Memories are reusable knowledge derived from that experience; they are not raw transcripts.

## Storage

The central store is SQLite.

Important tables:

- `traces`
- `jobs`
- `observations`
- `memories`
- `summaries`
- `memory_edges`
- `memory_feedback`
- `context_injections`
- `documents`
- `document_embeddings`

## Retrieval

Termyte uses more than one search path:

- FTS5 for keyword matching
- local embeddings for semantic similarity
- sqlite-vec when available
- a fallback scan when the native vector extension is missing
- reciprocal-rank fusion to combine scores

## Important Limit

The system is durable and traceable, but it is not yet a closed self-correcting loop.
It records exposure and feedback, but it does not yet prove downstream outcome and automatically repair memory behavior from that proof.
