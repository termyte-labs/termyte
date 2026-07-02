# Durable Ingestion Unification

## Objective

Make the durable `MemoryPipeline` and `JobQueue` the sole owners of asynchronous LLM, embedding, consolidation, and completion work. Hooks and synthesis may persist inputs and enqueue jobs, but they must not run unmanaged asynchronous work or mark traces and observations complete before memory embedding commits.

## Runtime ownership

`termyte-hook` normalizes and persists an agent event, then atomically transitions the resulting trace from `captured` to `observation_pending` and enqueues one idempotent `extract_observation` job. It returns to the agent without waiting for LLM or embedding work. It must return naturally instead of calling `process.exit()` from inside a `try` block.

`termyte synth` remains responsible for agent-driven batch observation extraction. For each valid response it atomically inserts observations with `processed_at = NULL`, transitions them to `awaiting_embedding`, and enqueues an `embed_observation` job. Source traces remain unprocessed until the downstream memory embedding job commits the active memory and provenance state.

`MemoryPipeline` is the only runtime component allowed to invoke the configured LLM and embeddings providers. Every such invocation occurs while processing a leased durable job. Embedding provider failures become `RetryableJobError`; no completion timestamps or downstream jobs are written on failure.

The legacy `Observer` remains only as a compatibility facade for callers that still depend on its public type. Its queue methods persist durable jobs rather than scheduling `setImmediate` work. Direct methods that perform LLM or embedding operations outside a lease are removed from runtime use.

## Atomic transitions

The following changes are single SQLite transactions:

1. Persist trace state and enqueue `extract_observation`.
2. Insert synthesized observations, set `awaiting_embedding`, and enqueue `embed_observation` jobs.
3. Persist an observation embedding and searchable document, set `indexed`, update trace state, and enqueue consolidation.
4. Persist a memory embedding and searchable document, set `active`, mark source observations and traces processed, and enqueue post-processing jobs.

No provider network call occurs inside a SQLite transaction. Calls occur after a job lease is acquired; successful results are committed atomically afterward. Failed calls leave the subject in its prior pending state and move the job through retry/backoff or dead-letter handling.

## Empty synthesis and extraction results

An extraction job that validly produces no observation may mark its source trace processed because no embedding or memory can correspond to it. Synth must use the same explicit terminal rule for a valid `<skip_summary />` result. Invalid synthesis output does not mark traces processed and remains retryable by a later synthesis attempt.

## Interfaces

`HookRunner.processEvent` returns the inserted `Trace` so callers can atomically enqueue that specific trace without querying by session or time.

`MemoryPipeline.ingestTrace(traceId)` remains the canonical trace-enqueue operation.

`Batcher` owns a `JobQueue` using the same database connection as `Store`. Its successful write transaction inserts all observations and jobs together. Job uniqueness on `(kind, subject_type, subject_id)` preserves idempotency.

## Failure behavior

- Embedding timeout or provider error: job becomes `failed`, subject stays `awaiting_embedding`, timestamps remain null.
- Process death after provider response but before commit: lease expires and the job retries; the idempotent document/job writes prevent duplicate downstream work.
- Process death during a transaction: SQLite rolls back all writes.
- Invalid LLM XML in a durable extraction/consolidation job: permanent failure and dead-letter visibility.
- Hook process termination after enqueue commit: durable worker can resume independently.

## Testing

Tests must verify:

- Hook ingestion creates exactly one pending extraction job and no inline observation.
- Hook completion does not depend on an observer flush or explicit `process.exit()`.
- Synth observations start with null `processed_at`, `awaiting_embedding`, and one pending embedding job.
- Synth source traces remain unprocessed until the durable pipeline reaches an active embedded memory.
- Embedding failure leaves subject state and timestamps unchanged while recording a retryable failed job.
- Successful embedding and lifecycle transitions commit together.
- No fire-and-forget `.then(...).catch(...)` embedding calls remain in production paths.

## Scope exclusions

This change does not implement sqlite-vec wiring, deduplication, decay scheduling, conflict resolution, or summary processing. Those jobs and retrieval concerns remain separate follow-up work.
