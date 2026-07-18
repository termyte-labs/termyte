import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, closeDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { Ingestor } from "../src/capture/ingest.js";

let ctx: DatabaseContext;
afterEach(() => { if (ctx) closeDatabase(ctx); });

describe("execution projections", () => {
  it("projects prompts, commands, tool results, and files atomically from traces", () => {
    ctx = openDatabase(":memory:");
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "r1", "/w");
    const ingest = new Ingestor(store);
    ingest.ingest({ session_id: "s1", timestamp: 1, event_type: "user_prompt", tool_name: null, tool_input: null, tool_output: null, files_read: null, files_modified: null, user_prompt: "Fix it", final_response: null, cwd: "/w" });
    ingest.ingest({ session_id: "s1", platform_event_id: "call-1", timestamp: 2, event_type: "tool_use", tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: { exit_code: 0 }, files_read: ["package.json"], files_modified: ["src/a.ts"], user_prompt: null, final_response: null, cwd: "/w" });
    const db = store.getDB();
    expect(db.prepare(`SELECT content, ordinal FROM prompts`).get()).toEqual({ content: "Fix it", ordinal: 1 });
    expect(db.prepare(`SELECT name, status, exit_code FROM tool_calls`).get()).toEqual({ name: "Bash", status: "completed", exit_code: 0 });
    expect(db.prepare(`SELECT command, cwd FROM commands`).get()).toEqual({ command: "npm test", cwd: "/w" });
    expect(db.prepare(`SELECT path, operation FROM file_changes ORDER BY operation`).all()).toEqual([{ path: "src/a.ts", operation: "modify" }, { path: "package.json", operation: "read" }]);
  });
});
