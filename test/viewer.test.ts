import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { JobQueue } from "../src/pipeline/job-queue.js";
import { RetryableJobError } from "../src/pipeline/errors.js";
import { startViewerServer, type RunningViewerServer } from "../src/viewer/server.js";

let running: RunningViewerServer | null = null;
let store: Store | null = null;

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
  if (store) {
    store.close();
    store = null;
  }
});

describe("viewer diagnostics server", () => {
  it("serves overview JSON on localhost", async () => {
    store = new Store(openDatabase(":memory:"));
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/overview`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.sessions).toBe(0);
    expect(body.data.memories).toBe(0);
    expect(body.data.health.queue.pending).toBe(0);
  });

  it("reports job summary counts", async () => {
    store = new Store(openDatabase(":memory:"));
    const queue = new JobQueue(store.getDB());
    queue.enqueueJob({ kind: "embed_memory", subjectType: "memory", subjectId: 1, nowMs: 100 });

    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/diagnostics`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.health.queue.pending).toBe(1);
    expect(body.data.health.queue.failed).toBe(0);
    expect(body.data.health.queue.dead).toBe(0);
  });

  it("returns failed and dead jobs from dead-letter endpoint", async () => {
    store = new Store(openDatabase(":memory:"));
    const queue = new JobQueue(store.getDB());
    queue.enqueueJob({
      kind: "embed_observation",
      subjectType: "observation",
      subjectId: 1,
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("viewer-test", { nowMs: 101 });
    expect(claimed).not.toBeNull();
    queue.markFailed(claimed!, new RetryableJobError("embedding timeout"), 102);

    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/diagnostics`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.problemJobs).toHaveLength(1);
    expect(body.data.problemJobs[0].state).toBe("failed");
    expect(body.data.problemJobs[0].last_error).toContain("embedding timeout");
  });

  it("serves a minimal dashboard and shuts down cleanly", async () => {
    store = new Store(openDatabase(":memory:"));
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(running.url);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("Termyte Viewer");

    await running.close();
    running = null;
  });
});
