import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { runMigrations } from "../src/storage/migrations.js";
import { PermanentJobError, RetryableJobError } from "../src/pipeline/errors.js";
import { JobQueue } from "../src/pipeline/job-queue.js";

let ctx: DatabaseContext;
let queue: JobQueue;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  runMigrations(ctx.db);
  queue = new JobQueue(ctx.db);
});

describe("JobQueue", () => {
  it("migrates the legacy permanent subject uniqueness without losing jobs", () => {
    const legacy = openDatabase(":memory:");
    legacy.db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL,
        state TEXT NOT NULL, attempt_count INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_owner TEXT, lease_until INTEGER, next_run_at INTEGER NOT NULL, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(kind, subject_type, subject_id)
      );
      INSERT INTO jobs VALUES ('legacy', 'update_summary', 'summary', 's1', 'succeeded', 1, 5, NULL, NULL, 0, NULL, 1, 2);
    `);

    runMigrations(legacy.db);
    const migrated = new JobQueue(legacy.db);
    expect(migrated.getJob("legacy")?.dedupeKey).toBe("once");
    expect(migrated.getJob("legacy")?.state).toBe("succeeded");
    expect(migrated.enqueueJob({
      kind: "update_summary", subjectType: "summary", subjectId: "s1", dedupeKey: "trace:2", id: "next",
    }).id).toBe("next");
    legacy.db.close();
  });

  it("enqueues jobs idempotently by kind and subject", () => {
    const first = queue.enqueueJob({
      kind: "extract_observation",
      subjectType: "trace",
      subjectId: 1,
      id: "job-a",
      nowMs: 100,
    });

    const second = queue.enqueueJob({
      kind: "extract_observation",
      subjectType: "trace",
      subjectId: 1,
      id: "job-b",
      nowMs: 200,
    });

    expect(second.id).toBe(first.id);
    expect(queue.getQueueStats().pending).toBe(1);
  });

  it("allows recurring jobs for the same subject when the dedupe key advances", () => {
    const first = queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: "sess-1",
      dedupeKey: "trace:10",
      id: "summary-10",
      nowMs: 100,
    });
    const duplicate = queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: "sess-1",
      dedupeKey: "trace:10",
      id: "duplicate",
      nowMs: 101,
    });
    const next = queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: "sess-1",
      dedupeKey: "trace:11",
      id: "summary-11",
      nowMs: 102,
    });

    expect(duplicate.id).toBe(first.id);
    expect(next.id).toBe("summary-11");
    expect(next.dedupeKey).toBe("trace:11");
    expect(queue.getQueueStats().pending).toBe(2);
  });

  it("claims one ready job atomically and leases it", () => {
    queue.enqueueJob({
      kind: "extract_observation",
      subjectType: "trace",
      subjectId: 1,
      id: "job-a",
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("worker-1", { nowMs: 200, leaseMs: 1_000 });
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe("job-a");
    expect(claimed!.state).toBe("leased");
    expect(claimed!.attemptCount).toBe(1);
    expect(claimed!.leaseOwner).toBe("worker-1");
    expect(claimed!.leaseUntil).toBe(1_200);

    expect(queue.claimNextJob("worker-2", { nowMs: 201 })).toBeNull();
    expect(queue.getQueueStats().leased).toBe(1);
  });

  it("marks retryable failure with backoff and makes it claimable later", () => {
    queue.enqueueJob({
      kind: "embed_observation",
      subjectType: "observation",
      subjectId: 7,
      id: "job-a",
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("worker-1", { nowMs: 200 })!;
    queue.markFailed(claimed, new RetryableJobError("embedding timeout"), 300);

    const failed = queue.getJob("job-a")!;
    expect(failed.state).toBe("failed");
    expect(failed.lastError).toContain("embedding timeout");
    expect(failed.nextRunAt).toBeGreaterThan(300);
    expect(queue.claimNextJob("worker-1", { nowMs: failed.nextRunAt - 1 })).toBeNull();

    const retried = queue.claimNextJob("worker-1", { nowMs: failed.nextRunAt });
    expect(retried).not.toBeNull();
    expect(retried!.attemptCount).toBe(2);
  });

  it("dead-letters permanent failures", () => {
    queue.enqueueJob({
      kind: "consolidate_memory",
      subjectType: "observation",
      subjectId: 3,
      id: "job-a",
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("worker-1", { nowMs: 200 })!;
    queue.markFailed(claimed, new PermanentJobError("missing observation"), 300);

    const dead = queue.getJob("job-a")!;
    expect(dead.state).toBe("dead");
    expect(dead.lastError).toContain("missing observation");
    expect(queue.getQueueStats().dead).toBe(1);
  });

  it("dead-letters retryable failures when max attempts are exhausted", () => {
    queue.enqueueJob({
      kind: "embed_memory",
      subjectType: "memory",
      subjectId: 9,
      id: "job-a",
      maxAttempts: 1,
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("worker-1", { nowMs: 200 })!;
    queue.markFailed(claimed, new RetryableJobError("provider down"), 300);

    expect(queue.getJob("job-a")!.state).toBe("dead");
  });

  it("recovers expired leases and allows another worker to claim", () => {
    queue.enqueueJob({
      kind: "update_summary",
      subjectType: "summary",
      subjectId: "sess-1",
      id: "job-a",
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("worker-1", { nowMs: 200, leaseMs: 50 })!;
    expect(claimed.state).toBe("leased");

    const recovered = queue.recoverExpiredLeases(251);
    expect(recovered).toBe(1);

    const reclaimed = queue.claimNextJob("worker-2", { nowMs: 252 });
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.leaseOwner).toBe("worker-2");
    expect(reclaimed!.attemptCount).toBe(2);
  });

  it("renews only the current owner's lease and rejects stale completion", () => {
    queue.enqueueJob({ kind: "extract_observation", subjectType: "trace", subjectId: 4, id: "job-a", nowMs: 100 });
    queue.claimNextJob("worker-1", { nowMs: 200, leaseMs: 50 });

    expect(queue.renewLease("job-a", "worker-2", { nowMs: 220, leaseMs: 100 })).toBe(false);
    expect(queue.renewLease("job-a", "worker-1", { nowMs: 220, leaseMs: 100 })).toBe(true);
    expect(queue.getJob("job-a")?.leaseUntil).toBe(320);

    queue.recoverExpiredLeases(321);
    queue.claimNextJob("worker-2", { nowMs: 322, leaseMs: 100 });
    expect(queue.markSucceeded("job-a", 323, "worker-1")).toBe(false);
    expect(queue.getJob("job-a")?.leaseOwner).toBe("worker-2");
    expect(queue.markSucceeded("job-a", 324, "worker-2")).toBe(true);
  });
});
