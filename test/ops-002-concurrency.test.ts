import { describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { JobQueue } from "../src/context/pipeline/job-queue.js";

describe("OPS-002 queue concurrency", () => {
  it("leases each queued job exactly once across multiple workers", () => {
    const ctx: DatabaseContext = openDatabase(":memory:");
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo", "/work");

    const queueA = new JobQueue(store.getDB());
    const queueB = new JobQueue(store.getDB());
    for (let i = 0; i < 50; i++) {
      queueA.enqueueJob({
        kind: "extract_observation",
        subjectType: "trace",
        subjectId: i,
      });
    }

    const claimed = new Set<string>();
    for (;;) {
      const first = queueA.claimNextJob("worker-a");
      const second = queueB.claimNextJob("worker-b");
      if (!first && !second) break;
      if (first) {
        expect(claimed.has(first.id)).toBe(false);
        claimed.add(first.id);
        queueA.markSucceeded(first.id);
      }
      if (second) {
        expect(claimed.has(second.id)).toBe(false);
        claimed.add(second.id);
        queueB.markSucceeded(second.id);
      }
    }

    expect(claimed.size).toBe(50);
    expect(store.getHealthDiagnostics().queue.succeeded).toBe(50);
    expect(store.getHealthDiagnostics().queue.pending).toBe(0);

    store.close();
  });
});
