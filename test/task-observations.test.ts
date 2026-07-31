import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { WorkThreadObservationStore } from "../src/tasks/observations.js";

describe("WorkThreadObservationStore", () => {
  it("rejects observations with missing source traces", () => {
    const ctx = openDatabase(":memory:"); new Store(ctx);
    expect(() => new WorkThreadObservationStore(ctx.db).insert({ task_id: "task", kind: "decision", claim: "Use FTS", source_event_ids: [99] })).toThrow(/existing trace/);
    ctx.db.close();
  });

  it("stores typed observations with many-to-many evidence links", () => {
    const ctx = openDatabase(":memory:"); const store = new Store(ctx);
    store.upsertSession("s", "repo", "repo", "/repo");
    const trace = store.insertTrace({ session_id: "s", timestamp: 1, event_type: "user_prompt", tool_name: null, tool_input: null, tool_output: null, files_read: [], files_modified: [], user_prompt: "task", final_response: null });
    const task = ctx.db.prepare("INSERT INTO tasks (id, repo_id, title, objective, status, version, created_at, updated_at) VALUES ('task', 'repo', 'Task', 'Task', 'active', 1, 1, 1)").run();
    expect(task.changes).toBe(1);
    const observation = new WorkThreadObservationStore(ctx.db).insert({ task_id: "task", kind: "verification", claim: "Prompt was captured", source_event_ids: [trace.id], confidence: 0.9 });
    expect(observation.lifecycle_state).toBe("active");
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM task_observation_evidence").get() as { n: number }).n).toBe(1);
    ctx.db.close();
  });
});
