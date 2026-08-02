import { describe, expect, it } from "vitest";
import { ClaudeCodeAdapter } from "../src/agents/adapters/claude-code.js";
import { CodexAdapter } from "../src/agents/adapters/codex.js";

describe("capture adapters", () => {
  it.each([
    [new ClaudeCodeAdapter(), "claude-code"],
    [new CodexAdapter(), "codex"],
  ] as const)("normalizes %s events", (adapter, name) => {
    const event = adapter.normalize({ session_id: "s1", cwd: process.cwd(), hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: { status: "ok" } });
    expect(adapter.name).toBe(name);
    expect(event?.event_type).toBe("tool_use");
    expect(event?.tool_name).toBe("Bash");
  });
});
