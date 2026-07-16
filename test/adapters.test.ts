import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "../src/capture/claude-code.js";
import { CodexAdapter } from "../src/capture/codex.js";
import { RawAdapter } from "../src/capture/raw.js";
import { extractCodexFilePaths } from "../src/capture/codex-file-context.js";
import { existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(event!.cwd).toBe("/work");
    expect(event!.tool_input).toEqual({ file_path: "src/a.ts" });
  });

  it("normalizes a UserPromptSubmit", () => {
    const event = a.normalize({
      session_id: "s1",
      cwd: "/work",
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
      cwd: "/work",
      last_assistant_message: "I fixed the auth bug.",
      hook_event_name: "Stop",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("assistant_message");
    expect(event!.final_response).toBe("I fixed the auth bug.");
  });

  it("falls back to process.cwd() when cwd is missing", () => {
    const event = a.normalize({ session_id: "s1", tool_name: "Read", tool_input: {} });
    expect(event).not.toBeNull();
    expect(event!.cwd).toBe(process.cwd());
  });

  it("formatOutput returns the agent envelope", () => {
    const out = a.formatOutput({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "ctx" },
    });
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "ctx" } });
  });
});

describe("CodexAdapter", () => {
  const a = new CodexAdapter();

  it("normalizes a tool_use", () => {
    const event = a.normalize({
      session_id: "s1",
      cwd: "/work",
      tool_name: "Edit",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "ok",
      hook_event_name: "PostToolUse",
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("tool_use");
    expect(event!.tool_input).toEqual({ file_path: "src/a.ts" });
  });

  it("normalizes a Stop event with the final response", () => {
    const event = a.normalize({
      session_id: "s1",
      cwd: "/work",
      last_assistant_message: "Done.",
      hook_event_name: "Stop",
    });
    expect(event).toMatchObject({ event_type: "assistant_message", final_response: "Done." });
  });

  it("attaches filePaths on PreToolUse Bash", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-codex-"));
    try {
      const file = join(dir, "exists.txt");
      writeFileSync(file, "x");
      const event = a.normalize({
        session_id: "s1",
        cwd: dir,
        tool_name: "Bash",
        tool_input: { command: `cat ${file} && cat /no/such/path` },
        hook_event_name: "PreToolUse",
      });
      expect(event).not.toBeNull();
      const ti = event!.tool_input as Record<string, unknown>;
      expect(Array.isArray(ti["filePaths"])).toBe(true);
      expect(ti["filePaths"]).toContain(file);
      // The non-existent path must NOT appear.
      expect((ti["filePaths"] as string[]).every((p) => existsSync(p))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("RawAdapter", () => {
  const a = new RawAdapter();

  it("normalizes a passthrough prompt event", () => {
    const event = a.normalize({ session_id: "s1", cwd: "/work", prompt: "hi" });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("user_prompt");
  });

  it("normalizes a passthrough tool event", () => {
    const event = a.normalize({
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "x.ts" },
    });
    expect(event).not.toBeNull();
    expect(event!.event_type).toBe("tool_use");
  });
});

describe("extractCodexFilePaths", () => {
  it("returns only existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-cfp-"));
    try {
      const f1 = join(dir, "a.txt");
      const f2 = join(dir, "b.txt");
      writeFileSync(f1, "x");
      writeFileSync(f2, "y");
      const out = extractCodexFilePaths("Bash", { command: `cat ${f1} ${f2} /no/such/file` }, dir);
      expect(out).toEqual([f1, f2]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles quoted paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-cfp-"));
    try {
      const f = join(dir, "q.txt");
      writeFileSync(f, "x");
      const out = extractCodexFilePaths("Bash", { command: `cat "${f}"` }, dir);
      expect(out).toEqual([f]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips flag values for head -n", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-cfp-"));
    try {
      const f = join(dir, "h.txt");
      writeFileSync(f, "x\ny\nz\n");
      const out = extractCodexFilePaths("Bash", { command: `head -n 5 ${f}` }, dir);
      expect(out).toEqual([f]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
