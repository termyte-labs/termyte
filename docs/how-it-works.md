# How It Works

Termyte follows a simple runtime path:

1. A supported agent emits a normalized event.
2. Termyte redacts obvious secrets and stores the event as a trace.
3. The trace is queued for durable background processing.
4. A detached `termyte-worker` claims the job and extracts observations.
5. Observations are consolidated into memories.
6. Memories are embedded, indexed, and made searchable.
7. Retrieval builds context and records what was injected.
8. Feedback is stored and can influence later ranking.

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

