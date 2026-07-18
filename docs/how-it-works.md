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
9. A terminal event or task switch closes the episode with a deterministic outcome.
10. Durable attribution classifies each delivered memory as `helped`, `hurt`, `unused`, or `unknown`.
11. Explicit feedback and bounded inferred help can influence later lifecycle and ranking.

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
