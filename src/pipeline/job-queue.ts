import type { DB } from "../storage/connection.js";
import {
  computeBackoffMs,
  isRetryableJobError,
  serializeJobError,
} from "./errors.js";

export type JobState = "pending" | "leased" | "succeeded" | "failed" | "dead";

export type JobKind =
  | "extract_observation"
  | "embed_observation"
  | "consolidate_memory"
  | "embed_memory"
  | "dedupe_memories"
  | "update_summary";

export type JobSubjectType = "trace" | "observation" | "memory" | "summary" | "episode";

export interface Job {
  id: string;
  kind: JobKind;
  subjectType: JobSubjectType;
  subjectId: string;
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

    this.db.prepare(`
      INSERT OR IGNORE INTO jobs (
        id,
        kind,
        subject_type,
        subject_id,
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
      maxAttempts: input.maxAttempts ?? 5,
      nextRunAt: input.nextRunAt ?? nowMs,
      createdAt: nowMs,
      updatedAt: nowMs,
    });

    const job = this.getBySubject(input.kind, input.subjectType, subjectId);
    if (!job) {
      throw new Error(`Failed to enqueue job ${input.kind}:${input.subjectType}:${subjectId}`);
    }
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

  markSucceeded(jobId: string, nowMs = Date.now()): void {
    this.db.prepare(`
      UPDATE jobs
      SET
        state = 'succeeded',
        lease_owner = NULL,
        lease_until = NULL,
        updated_at = @nowMs
      WHERE id = @jobId
    `).run({ jobId, nowMs });
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
    `).run({ jobId: job.id, nextRunAt, lastError, nowMs });
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
    `).run({
      jobId: job.id,
      lastError: serializeJobError(error),
      nowMs,
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

  getJob(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
    return row ? mapJob(row) : null;
  }

  private getBySubject(kind: JobKind, subjectType: JobSubjectType, subjectId: string): Job | null {
    const row = this.db.prepare(`
      SELECT *
      FROM jobs
      WHERE kind = ? AND subject_type = ? AND subject_id = ?
    `).get(kind, subjectType, subjectId);
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
