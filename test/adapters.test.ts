import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "../src/capture/claude-code.js";
import { CodexAdapter } from "../src/capture/codex.js";
import { OpenCodeAdapter } from "../src/capture/opencode.js";
import { CursorAdapter } from "../src/capture/cursor.js";

describe("ClaudeCodeAdapter", () => {
  const a = new ClaudeCodeAdapter();

  it("returns null when there is no session_id", () => {
    expect(a.normalize({ tool_name: "Read" })).toBeNull();
  });

  it("normalizes a PostToolUse event", () => {
    const event = a.normalize({
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "content",
      hook_event_name: "PostToolUse",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("tool_use");
    expect(event!.tool_name).toBe("Read");
    expect(event!.files_read).toEqual(["src/a.ts"]);
    expect(event!.files_modified).toBeNull();
    expect(event!.cwd).toBe("/work");
  });

  it("normalizes a UserPromptSubmit", () => {
    const event = a.normalize({
      session_id: "s1",
      prompt: "Fix the login bug",
      hook_event_name: "UserPromptSubmit",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("user_prompt");
    expect(event!.user_prompt).toBe("Fix the login bug");
  });

  it("normalizes a Stop event with the last assistant message", () => {
    const event = a.normalize({
      session_id: "s1",
      last_assistant_message: "I fixed the auth bug.",
      hook_event_name: "Stop",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("assistant_message");
    expect(event!.final_response).toBe("I fixed the auth bug.");
  });
});

describe("CodexAdapter", () => {
  const a = new CodexAdapter();

  it("normalizes a tool_use", () => {
    const event = a.normalize({
      session_id: "s1",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "ok",
      hook_event_name: "PostToolUse",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("tool_use");
    expect(event!.files_modified).toEqual(["src/a.ts"]);
  });
});

describe("OpenCodeAdapter", () => {
  const a = new OpenCodeAdapter();

  it("normalizes a tool.execute.after event", () => {
    const event = a.normalize({
      sessionID: "s1",
      tool: "Read",
      args: { file_path: "src/a.ts" },
      output: "content",
      directory: "/work",
    });
    expect(event).not.toBeNull();
    expect(event!.session_id).toBe("s1");
    expect(event!.event_type).toBe("tool_use");
    expect(event!.tool_name).toBe("Read");
    expect(event!.files_read).toEqual(["src/a.ts"]);
    expect(event!.cwd).toBe("/work");
  });

  it("normalizes a session.idle event as assistant_message", () => {
    const event = a.normalize({
      sessionID: "s1",
      event: "session.idle",
      last_assistant_message: "done",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("assistant_message");
    expect(event!.final_response).toBe("done");
  });

  it("normalizes a chat.message assistant event", () => {
    const event = a.normalize({
      sessionID: "s1",
      message: { role: "assistant", content: "I did the thing." },
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("assistant_message");
    expect(event!.final_response).toBe("I did the thing.");
  });
});

describe("CursorAdapter", () => {
  const a = new CursorAdapter();

  it("normalizes a beforeSubmitPrompt event", () => {
    const event = a.normalize({
      conversation_id: "s1",
      workspace_roots: ["/work"],
      event: "beforeSubmitPrompt",
      prompt: "Refactor the API",
    });
    expect(event).not.toBeNull();
    expect(event!.session_id).toBe("s1");
    expect(event!.event_type).toBe("user_prompt");
    expect(event!.cwd).toBe("/work");
  });

  it("normalizes a tool event with result_json", () => {
    const event = a.normalize({
      conversation_id: "s1",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      result_json: { ok: true },
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("tool_use");
    expect(event!.tool_output).toEqual({ ok: true });
    expect(event!.files_read).toEqual(["src/a.ts"]);
  });

  it("normalizes a stop event with last_assistant_message", () => {
    const event = a.normalize({
      conversation_id: "s1",
      event: "stop",
      last_assistant_message: "all done",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("assistant_message");
    expect(event!.final_response).toBe("all done");
  });
});
