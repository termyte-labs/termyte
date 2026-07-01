# Durable Pipeline Agent Prompt

## 1. Target Role & Objective

You are the Backend Engineer responsible for the Durable Pipeline refactor in Termyte.

Your objective is to replace fragile ingestion behavior with a durable, transactional job-processing system. Termyte must guarantee that traces, observations, memories, embeddings, and search documents move through explicit states. An observation or memory must never be marked processed, indexed, or searchable until its durable row, embedding, and search index entry are committed successfully.

You own:

- jobs table
- worker loop
- job leases
- retry/backoff behavior
- dead-letter state
- strict artifact state transitions
- ingestion pipeline orchestration
- embedding retry mechanism
- “processed only after committed to search” invariant

## 2. Domain Boundaries & Monitored Interfaces

You own these modules:

```txt
src/pipeline/job-queue.ts
src/pipeline/memory-pipeline.ts
src/pipeline/workers.ts
src/pipeline/errors.ts
src/storage/jobs.ts
src/storage/pipeline-state.ts
```

You may modify:

```txt
src/storage/migrations.ts
src/storage/store.ts
src/observer/pipeline.ts
src/synth/batcher.ts
src/cli/worker.ts
src/hooks/runner.ts
```

You must expose these public APIs:

```ts
interface JobQueue {
  enqueueJob(input: EnqueueJobInput): void;
  claimNextJob(workerId: string): Job | null;
  markSucceeded(jobId: string): void;
  markFailed(job: Job, error: unknown): void;
  markDead(job: Job, error: unknown): void;
  recoverExpiredLeases(nowMs: number): number;
}

interface MemoryPipeline {
  ingestTrace(traceId: string): void;
  runOnce(workerId: string): Promise<boolean>;
  runUntilIdle(workerId: string, maxJobs?: number): Promise<number>;
}
```

You must produce or update these database tables/columns:

```sql
jobs
traces.pipeline_state
observations.lifecycle_state
memories.lifecycle_state
```

Other modules will depend on these state values:

```ts
type JobState = "pending" | "leased" | "succeeded" | "failed" | "dead";

type TracePipelineState =
  | "captured"
  | "observation_pending"
  | "observation_ready"
  | "memory_pending"
  | "memory_ready"
  | "failed";

type ObservationLifecycleState =
  | "extracting"
  | "awaiting_embedding"
  | "indexed"
  | "failed"
  | "superseded"
  | "deleted";

type MemoryLifecycleState =
  | "consolidating"
  | "awaiting_embedding"
  | "active"
  | "stale"
  | "superseded"
  | "conflicted"
  | "deleted"
  | "failed";
```

## 3. Strict Architectural Constraints

- Must use SQLite through existing `better-sqlite3`.
- Must use explicit SQLite transaction blocks for all state transitions.
- Must not hold a SQLite transaction open while calling an LLM, embedding provider, HTTP API, or local ML model.
- Must not mark a trace `processed_at` until mandatory downstream jobs are complete.
- Must not mark an observation `indexed` until its document row and embedding/vector index entry have committed.
- Must not swallow job failures silently.
- Must support retryable and permanent failures.
- Must support lease expiration so a crashed worker does not permanently block a job.
- Must preserve existing TypeScript ESM import convention using `.js` extensions.
- Must keep tests deterministic and network-free.
- Must not introduce Redis, Postgres, Chroma, LanceDB, Qdrant, or external queues.
- Must remain local-first and SQLite-backed.

## 4. Step-by-Step Implementation Checklist

### Phase 1: Schema

Add a `jobs` table:

```sql
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'leased', 'succeeded', 'failed', 'dead')
  ),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  lease_until INTEGER,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, subject_type, subject_id)
);
```

Add indexes:

```sql
CREATE INDEX IF NOT EXISTS jobs_ready_idx
ON jobs(state, next_run_at, kind);

CREATE INDEX IF NOT EXISTS jobs_lease_idx
ON jobs(state, lease_until);

CREATE INDEX IF NOT EXISTS jobs_subject_idx
ON jobs(subject_type, subject_id);
```

Add lifecycle columns:

```sql
ALTER TABLE traces ADD COLUMN pipeline_state TEXT DEFAULT 'captured';
ALTER TABLE observations ADD COLUMN lifecycle_state TEXT DEFAULT 'extracting';
ALTER TABLE memories ADD COLUMN lifecycle_state TEXT DEFAULT 'consolidating';
```

Handle already-existing-column errors safely in migrations.

### Phase 2: Job Queue

Implement `JobQueue` with:

- `enqueueJob`
- `claimNextJob`
- `markSucceeded`
- `markFailed`
- `markDead`
- `recoverExpiredLeases`
- `getQueueStats`

Claim jobs with a single atomic SQL `UPDATE ... RETURNING`.

Required behavior:

```txt
pending job -> leased
leased success -> succeeded
leased retryable failure -> failed with next_run_at backoff
leased permanent failure -> dead
leased expired -> claimable again
failed with attempts left -> claimable after next_run_at
failed with attempts exhausted -> dead
```

### Phase 3: Error Classes

Implement:

```ts
class RetryableJobError extends Error {}
class PermanentJobError extends Error {}
```

Add helper:

```ts
function isRetryableJobError(error: unknown): boolean;
function serializeJobError(error: unknown): string;
function computeBackoffMs(attemptCount: number): number;
```

Backoff formula:

```ts
const baseMs = 2_000;
const maxMs = 10 * 60_000;
const jitterMs = Math.floor(Math.random() * 1_000);
return Math.min(maxMs, baseMs * 2 ** Math.max(0, attemptCount - 1)) + jitterMs;
```

### Phase 4: Unified Pipeline

Implement one canonical job sequence:

```txt
trace captured
  -> extract_observation
  -> embed_observation
  -> consolidate_memory
  -> embed_memory
  -> dedupe_memories
  -> update_summary
```

Required job kinds:

```ts
type JobKind =
  | "extract_observation"
  | "embed_observation"
  | "consolidate_memory"
  | "embed_memory"
  | "dedupe_memories"
  | "update_summary";
```

Update existing `synth` and `worker` entry points so they both enqueue or execute this same pipeline. No second divergent processing path may remain.

### Phase 5: Strict Commit Rules

Implement these invariants:

- `observations.lifecycle_state = 'indexed'` only after observation exists, document row exists, embedding row/vector row exists unless embeddings are explicitly disabled, and transaction committed.
- `memories.lifecycle_state = 'active'` only after memory exists, document row exists, embedding/vector row exists unless embeddings are explicitly disabled, and transaction committed.
- `traces.processed_at` only set when related observation and memory jobs reach terminal success or explicit skip.

### Phase 6: CLI Worker

Update `termyte-worker` to support:

```txt
termyte-worker --once
termyte-worker --until-idle
termyte-worker --max-jobs 100
termyte-worker --worker-id local-worker-1
```

Worker must print useful JSON stats when `--json` is passed.

## 5. Expected Output & Testing Criteria

You must add unit tests for:

- enqueue idempotency
- atomic job claiming
- lease expiration recovery
- retryable failure backoff
- permanent failure dead-lettering
- max attempts dead-lettering
- observation not marked indexed before embedding succeeds
- observation remains retryable if embedding throws
- trace not marked processed if downstream memory embedding fails
- `synth` and `worker` paths use same durable pipeline

Mock interface:

```ts
class MockEmbeddingsProvider {
  calls = 0;
  shouldThrow = false;

  async embed(text: string): Promise<Float32Array> {
    this.calls++;
    if (this.shouldThrow) throw new Error("embedding timeout");
    return new Float32Array([1, 0, 0, 0]);
  }
}
```

Edge cases to handle:

- process crashes after LLM extraction but before embedding
- embedding provider timeout
- malformed LLM XML
- duplicate job enqueue
- expired lease
- missing trace
- missing observation
- missing memory
- migration on existing database

Acceptance criteria:

```txt
npm run typecheck passes
npm test passes
```
