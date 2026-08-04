import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { HookRunner } from "../src/agents/hooks/runner.js";
import { installClaudeCodeHooks } from "../src/agents/installers/claude-code.js";
import { installCodexHooks } from "../src/agents/installers/codex.js";

const temporary: string[] = [];
afterEach(() => {
  delete process.env.TERMYTE_HOOK_PATH;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("minimal Termyte runtime", () => {
  it("captures every turn, redacts secrets, and retrieves a stored handoff", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "termyte-core-")); temporary.push(workspace);
    const store = new Store(openDatabase(":memory:"));
    const runner = new HookRunner(store);

    await runner.processRaw("codex", {
      session_id: "session-1", cwd: workspace, timestamp: 1,
      hook_event_name: "UserPromptSubmit", prompt: "Fix login with token sk-12345678901234567890",
    });
    await runner.processRaw("codex", {
      session_id: "session-1", cwd: workspace, timestamp: 2,
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "npm test" }, tool_output: { status: "ok" },
    });
    const traces = store.getTracesForSession("session-1");
    expect(traces).toHaveLength(2);
    expect(JSON.stringify(traces)).not.toContain("sk-12345678901234567890");
    expect(JSON.stringify(traces)).toContain("[REDACTED:api_key]");

    const session = store.getSession("session-1")!;
    store.upsertSession("session-2", "repo", session.repo_id!, workspace);
    store.saveHandoff({
      sourceSessionId: "session-1", targetSessionId: "session-2", repoId: session.repo_id!,
      content: "What happened\nLogin was fixed.\n\nWhy\nTokens had whitespace.\n\nWhat remains\nRun the full suite.\n\nNext step\nRun npm test.",
    });
    expect(store.searchHandoffs(session.repo_id!, "why token decision")).toHaveLength(1);
    store.close();
  });

  it("installs capture, prompt context, and session briefing hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-hooks-")); temporary.push(home);
    process.env.TERMYTE_HOOK_PATH = join(process.cwd(), "dist", "cli", "hook.js");
    expect(installClaudeCodeHooks({ target: "user", homeDir: home })).toBe(0);
    expect(installCodexHooks({ target: "user", homeDir: home })).toBe(0);
    for (const file of [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")]) {
      const hooks = JSON.parse(readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
      expect(hooks.SessionStart![0]!.hooks[0]!.command).toContain("session-init");
      expect(hooks.UserPromptSubmit![0]!.hooks[0]!.command).toContain("prompt-context");
      expect(hooks.PostToolUse![0]!.hooks[0]!.command).toContain("capture");
      expect(hooks.Stop![0]!.hooks[0]!.command).toContain("capture");
    }
  });
});
