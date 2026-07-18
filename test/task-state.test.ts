import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, closeDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { TaskStateService, TaskVersionConflict } from "../src/task-state/service.js";
import { Store } from "../src/storage/store.js";

let ctx: DatabaseContext;
afterEach(() => { if (ctx) closeDatabase(ctx); });

describe("authoritative task state", () => {
  it("requires passing non-agent evidence before verifying a step", () => {
    ctx = openDatabase(":memory:"); new Store(ctx); const service = new TaskStateService(ctx.db);
    const task = service.createTask({ repoId: "r1", title: "Pivot", objective: "Ship it", now: 1 });
    const step = service.addStep({ taskId: task.id, title: "Test", position: 1, expectedVersion: 1, now: 2 });
    expect(() => service.updateStep({ taskId: task.id, stepId: step.id, status: "verified", expectedVersion: 2, actor: "agent" })).toThrow("Agent statements");
    const evidence = service.recordEvidence({ taskId: task.id, kind: "test", verdict: "passed", payload: { command: "npm test" }, now: 3 });
    expect(service.updateStep({ taskId: task.id, stepId: step.id, status: "verified", expectedVersion: 2, evidenceIds: [evidence.id], actor: "verifier", now: 4 }).status).toBe("verified");
    expect(service.updateTaskStatus({ taskId: task.id, status: "completed", expectedVersion: 3, actor: "verifier", now: 5 }).status).toBe("completed");
  });

  it("rejects stale writers without partial state", () => {
    ctx = openDatabase(":memory:"); new Store(ctx); const service = new TaskStateService(ctx.db);
    const task = service.createTask({ repoId: "r1", title: "Pivot", objective: "Ship it" });
    service.addStep({ taskId: task.id, title: "One", position: 1, expectedVersion: 1 });
    expect(() => service.addStep({ taskId: task.id, title: "Two", position: 2, expectedVersion: 1 })).toThrow(TaskVersionConflict);
    expect((ctx.db.prepare(`SELECT COUNT(*) AS n FROM task_steps`).get() as { n: number }).n).toBe(1);
  });
});
