import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { TaskDetectionService } from "../src/task-state/detection.js";
import type { NormalizedEvent } from "../src/capture/adapter.js";

function event(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    session_id: "session-1", timestamp: 1_000, event_type: "user_prompt", tool_name: null,
    tool_input: null, tool_output: null, files_read: ["src/auth.ts"], files_modified: [],
    user_prompt: "Fix signup authentication", final_response: null, cwd: "/repo", ...overrides,
  };
}

describe("TaskDetectionService", () => {
  it("creates a Work Thread for a first prompt and records evidence", () => {
    const ctx = openDatabase(":memory:"); new Store(ctx);
    const result = new TaskDetectionService(ctx.db).detect({ event: event(), repoId: "repo", workspaceRoot: "/repo", traceId: 7 });
    expect(result.detection.decision).toBe("new");
    expect(result.taskId).toBeTruthy();
    expect((ctx.db.prepare("SELECT COUNT(*) AS n FROM task_memberships WHERE entity_id = '7'").get() as { n: number }).n).toBe(1);
    ctx.db.close();
  });

  it("continues the same task when session, workspace, and file signals match", () => {
    const ctx = openDatabase(":memory:"); const store = new Store(ctx);
    const detector = new TaskDetectionService(ctx.db);
    const first = detector.detect({ event: event(), repoId: "repo", workspaceRoot: "/repo" });
    const second = detector.detect({ event: event({ timestamp: 1_100, event_type: "tool_use", user_prompt: null, tool_name: "Bash" }), repoId: "repo", workspaceRoot: "/repo", traceId: 8 });
    expect(second.detection.decision).toBe("continue");
    expect(second.taskId).toBe(first.taskId);
    expect(store.getDB().prepare("SELECT COUNT(*) AS n FROM task_detections WHERE decision = 'continue'").get()).toEqual({ n: 1 });
    ctx.db.close();
  });
});
