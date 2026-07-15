import type { DB } from "../storage/connection.js";
import {
  computeBackoffMs,
  isRetryableJobError,
  serializeJobError,
} from "./errors.js";

export type JobState = "pending" | "leased" | "succeeded" | "failed" | "dead";

export type JobKind =
  | "synthesize_episode"
  | "consolidate_episode"
  | "extract_observation"
  | "embed_observation"
  | "consolidate_memory"
  | "embed_memory"
  | "dedupe_memories"
  | "update_summary"
  | "decay_memories"
  | "verify_memory";

export type JobSubjectType = "trace" | "observation" | "memory" | "summary" | "episode";

export interface Job {
  id: string;
  kind: JobKind;
  subjectType: JobSubjectType;
  subjectId: string;
  dedupeKey: string;
  state: JobState;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  nextRunAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EnqueueJobInput {
  kind: JobKind;
  subjectType: JobSubjectType;
  subjectId: string | number;
  dedupeKey?: string;
  id?: string;
  maxAttempts?: number;
  nextRunAt?: number;
  nowMs?: number;
}

export interface QueueStats {
  pending: number;
  leased: number;
  succeeded: number;
  failed: number;
  dead: number;
}

export class JobQueue {
  constructor(private readonly db: DB) {}

  enqueueJob(input: EnqueueJobInput): Job {
    const nowMs = input.nowMs ?? Date.now();
    const id = input.id ?? createJobId();
    const subjectId = String(input.subjectId);
    const dedupeKey = input.dedupeKey ?? "once";

    this.db.prepare(`
      INSERT OR IGNORE INTO jobs (
        id,
        kind,
        subject_type,
        subject_id,
        dedupe_key,
        state,
        attempt_count,
        max_attempts,
        next_run_at,
        created_at,
        updated_at
      )
      VALUES (
        @id,
        @kind,
        @subjectType,
        @subjectId,
        @dedupeKey,
        'pending',
        0,
        @maxAttempts,
        @nextRunAt,
        @createdAt,
        @updatedAt
      )
    `).run({
      id,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId,
      dedupeKey,
      maxAttempts: input.maxAttempts ?? 5,
      nextRunAt: input.nextRunAt ?? nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
    });

    const job = this.getBySubject(input.kind, input.subjectType, subjectId, dedupeKey);
    if (!job) {
      throw new Error(`Failed to enqueue job ${input.kind}:${input.subjectType}:${subjectId}`);
    }
    return job;
  }

  /** Refresh one scheduled row without disturbing a live lease or dead letter. */
  coalesceJob(input: EnqueueJobInput): Job {
    const nowMs = input.nowMs ?? Date.now();
    const subjectId = String(input.subjectId);
    const dedupeKey = input.dedupeKey ?? "once";

    this.db.prepare(`
      INSERT INTO jobs (
        id, kind, subject_type, subject_id, dedupe_key, state,
        attempt_count, max_attempts, next_run_at, created_at, updated_at
      ) VALUES (
        @id, @kind, @subjectType, @subjectId, @dedupeKey, 'pending',
        0, @maxAttempts, @nextRunAt, @nowMs, @nowMs
      )
      ON CONFLICT(kind, subject_type, subject_id, dedupe_key) DO UPDATE SET
        state = 'pending',
        attempt_count = 0,
        max_attempts = excluded.max_attempts,
        lease_owner = NULL,
        lease_until = NULL,
        next_run_at = excluded.next_run_at,
        last_error = NULL,
        updated_at = excluded.updated_at
      WHERE jobs.state IN ('pending', 'failed', 'succeeded')
    `).run({
      id: input.id ?? createJobId(),
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId,
      dedupeKey,
      maxAttempts: input.maxAttempts ?? 5,
      nextRunAt: input.nextRunAt ?? nowMs,
      nowMs,
    });

    const job = this.getBySubject(input.kind, input.subjectType, subjectId, dedupeKey);
    if (!job) throw new Error(`Failed to coalesce job ${input.kind}:${input.subjectType}:${subjectId}`);
    return job;
  }

  claimNextJob(workerId: string, options: { nowMs?: number; leaseMs?: number } = {}): Job | null {
    const nowMs = options.nowMs ?? Date.now();
    const leaseUntil = nowMs + (options.leaseMs ?? 60_000);

    const tx = this.db.transaction(() => {
      this.promoteExpiredLeases(nowMs);
      this.moveExhaustedFailedJobsToDead(nowMs);

      const row = this.db.prepare(`
        UPDATE jobs
        SET
          state = 'leased',
          lease_owner = @workerId,
          lease_until = @leaseUntil,
          attempt_count = attempt_count + 1,
          updated_at = @nowMs
        WHERE id = (
          SELECT id
          FROM jobs
          WHERE
            state IN ('pending', 'failed')
            AND next_run_at <= @nowMs
            AND attempt_count < max_attempts
          ORDER BY next_run_at ASC, created_at ASC
          LIMIT 1
        )
        RETURNING *
      `).get({ workerId, leaseUntil, nowMs });

      return row ? mapJob(row) : null;
    });

    return tx();
  }

  markSucceeded(jobId: string, nowMs = Date.now(), leaseOwner?: string): boolean {
    const result = this.db.prepare(`
      UPDATE jobs
      SET
        state = 'succeeded',
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = @nowMs
      WHERE id = @jobId
        AND (@leaseOwner IS NULL OR (state = 'leased' AND lease_owner = @leaseOwner))
    `).run({ jobId, nowMs, leaseOwner: leaseOwner ?? null });
    return result.changes === 1;
  }

  /** Extend a live lease only when it is still owned by this worker. */
  renewLease(jobId: string, workerId: string, options: { nowMs?: number; leaseMs?: number } = {}): boolean {
    const nowMs = options.nowMs ?? Date.now();
    const leaseUntil = nowMs + (options.leaseMs ?? 60_000);
    const result = this.db.prepare(`
      UPDATE jobs SET lease_until = @leaseUntil, updated_at = @nowMs
      WHERE id = @jobId AND state = 'leased' AND lease_owner = @workerId
    `).run({ jobId, workerId, leaseUntil, nowMs });
    return result.changes === 1;
  }

  markFailed(job: Job, error: unknown, nowMs = Date.now()): void {
    const attemptsUsed = job.attemptCount;
    const lastError = serializeJobError(error);

    if (!isRetryableJobError(error) || attemptsUsed >= job.maxAttempts) {
      this.markDead(job, error, nowMs);
      return;
    }

    const nextRunAt = nowMs + computeBackoffMs(attemptsUsed);
    this.db.prepare(`
      UPDATE jobs
      SET
        state = 'failed',
        lease_owner = NULL,
        lease_until = NULL,
        next_run_at = @nextRunAt,
        last_error = @lastError,
        updated_at = @nowMs
      WHERE id = @jobId
        AND state = 'leased' AND lease_owner = @leaseOwner
    `).run({ jobId: job.id, nextRunAt, lastError, nowMs, leaseOwner: job.leaseOwner });
  }

  markDead(job: Job, error: unknown, nowMs = Date.now()): void {
    this.db.prepare(`
      UPDATE jobs
      SET
        state = 'dead',
        lease_owner = NULL,
        lease_until = NULL,
        last_error = @lastError,
        updated_at = @nowMs
      WHERE id = @jobId
        AND state = 'leased' AND lease_owner = @leaseOwner
    `).run({
      jobId: job.id,
      lastError: serializeJobError(error),
      nowMs,
      leaseOwner: job.leaseOwner,
    });
  }

  recoverExpiredLeases(nowMs = Date.now()): number {
    const result = this.promoteExpiredLeases(nowMs);
    return result.changes;
  }

  getQueueStats(): QueueStats {
    const stats: QueueStats = {
      pending: 0,
      leased: 0,
      succeeded: 0,
      failed: 0,
      dead: 0,
    };

    const rows = this.db.prepare(`
      SELECT state, COUNT(*) AS count
      FROM jobs
      GROUP BY state
    `).all() as Array<{ state: JobState; count: number }>;

    for (const row of rows) {
      stats[row.state] = row.count;
    }

    return stats;
  }

  getNextRunAt(): number | null {
    const row = this.db.prepare(`
      SELECT MIN(next_run_at) AS next_run_at FROM jobs
      WHERE state IN ('pending', 'failed') AND attempt_count < max_attempts
    `).get() as { next_run_at: number | null };
    return row.next_run_at;
  }

  getJob(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return row ? mapJob(row) : null;
  }

  private getBySubject(kind: JobKind, subjectType: JobSubjectType, subjectId: string, dedupeKey: string): Job | null {
    const row = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE kind = ? AND subject_type = ? AND subject_id = ? AND dedupe_key = ?
    `).get(kind, subjectType, subjectId, dedupeKey);
    return row ? mapJob(row) : null;
  }

  private promoteExpiredLeases(nowMs: number): { changes: number } {
    return this.db.prepare(`
      UPDATE jobs
      SET
        state = 'failed',
        lease_owner = NULL,
        lease_until = NULL,
        next_run_at = @nowMs,
        last_error = COALESCE(last_error, 'lease expired'),
        updated_at = @nowMs
      WHERE state = 'leased' AND lease_until IS NOT NULL AND lease_until < @nowMs
    `).run({ nowMs });
  }

  private moveExhaustedFailedJobsToDead(nowMs: number): void {
    this.db.prepare(`
      UPDATE jobs
      SET
        state = 'dead',
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = @nowMs
      WHERE state = 'failed' AND attempt_count >= max_attempts
    `).run({ nowMs });
  }
}

function mapJob(row: any): Job {
  return {
    id: row.id,
    kind: row.kind,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    dedupeKey: row.dedupe_key,
    state: row.state,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    nextRunAt: row.next_run_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createJobId(): string {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
