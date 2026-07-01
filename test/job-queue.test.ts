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
});
