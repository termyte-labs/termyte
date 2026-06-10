import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import { MemoryEngine } from "../src/memory.js";
import {
  formatAgentHookResponse,
  handleAgentHookInvocation,
  installAgentHooks,
  uninstallAgentHooks,
  verifyAgentHooks,
} from "../src/agent-hook.js";

function workspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseHookOutput(stdout: string): Record<string, unknown> {
  return stdout ? JSON.parse(stdout) as Record<string, unknown> : {};
}

describe("agent native hook bridge", () => {
  it("blocks Claude Bash rm -rf and returns Claude deny JSON", async () => {
    const cwd = workspace("termyte-claude-hook-block-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_name: "Bash",
        tool_input: { command: "rm -rf ." },
      }),
    });

    const output = parseHookOutput(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
    const record = new Ledger(openDatabase(dbPath).db).getById(result.ledgerId ?? 0);

    expect(result.decision).toBe("block");
    expect(result.exitCode).toBe(0);
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Termyte block:");
    expect(record?.status).toBe("blocked");
    expect(record?.decision).toBe("block");
    expect(record?.semanticId).toBe("filesystem.delete.recursive.force");
  });

  it("allows Claude Bash git status and stays silent", async () => {
    const cwd = workspace("termyte-claude-hook-allow-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_call_id: "tool-allow-1",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });
    const record = new Ledger(openDatabase(dbPath).db).getById(result.ledgerId ?? 0);

    expect(result.decision).toBe("allow");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(record?.status).toBe("planned");
    expect(record?.decision).toBe("allow");
  });

  it("blocks Claude writes to .env and allows an edit to a source file", async () => {
    const cwd = workspace("termyte-claude-hook-write-");
    const dbPath = path.join(cwd, "termyte.db");

    const blocked = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "TOKEN=secret" },
      }),
    });
    const allowed = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_call_id: "tool-edit-1",
        tool_name: "Edit",
        tool_input: { file_path: "src/app.ts", content: "export const value = 1;" },
      }),
    });

    expect(blocked.decision).toBe("block");
    expect(parseHookOutput(blocked.stdout).hookSpecificOutput).toBeTruthy();
    expect(allowed.decision).toBe("allow");
    expect(allowed.stdout).toBe("");
  });

  it("blocks Claude mcp__ tool calls that look dangerous", async () => {
    const cwd = workspace("termyte-claude-hook-mcp-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_name: "mcp__github__delete_repo",
        tool_input: {},
      }),
    });

    expect(result.decision).toBe("block");
    expect(parseHookOutput(result.stdout).hookSpecificOutput).toBeTruthy();
  });

  it("updates the ledger and memory on PostToolUse", async () => {
    const cwd = workspace("termyte-claude-hook-post-");
    const dbPath = path.join(cwd, "termyte.db");
    const correlationId = "tool-post-1";

    const pre = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "claude-session",
        tool_call_id: correlationId,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });

    const post = await handleAgentHookInvocation({
      agent: "claude",
      phase: "post",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PostToolUse",
        cwd,
        session_id: "claude-session",
        tool_call_id: correlationId,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        stdout: "clean\n",
        exit_code: 0,
      }),
    });

    const ctx = openDatabase(dbPath);
    const ledger = new Ledger(ctx.db);
    const memory = new MemoryEngine(ctx.db);
    const record = ledger.getById(pre.ledgerId ?? 0);
    const memoryRows = memory.list(10);

    expect(pre.decision).toBe("allow");
    expect(post.decision).toBe("allow");
    expect(post.stdout).toBe("");
    expect(record?.status).toBe("executed");
    expect(record?.decision).toBe("allow");
    expect(memoryRows[0]?.semanticId).toBe("shell.generic");
  });

  it("returns Codex deny JSON for blocked actions and silent output for allow", async () => {
    const cwd = workspace("termyte-codex-hook-");
    const dbPath = path.join(cwd, "termyte.db");
    const blocked = await handleAgentHookInvocation({
      agent: "codex",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "codex-session",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
      }),
    });
    const allowed = await handleAgentHookInvocation({
      agent: "codex",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "codex-session",
        tool_call_id: "tool-allow-1",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });

    expect(blocked.exitCode).toBe(0);
    expect(parseHookOutput(blocked.stdout).hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(allowed.exitCode).toBe(0);
    expect(allowed.stdout).toBe("");
  });

  it("maps warn decisions to ask JSON for Claude and system messages for Codex", () => {
    const claude = parseHookOutput(formatAgentHookResponse("claude", "PreToolUse", "warn", "approval required")) as {
      hookSpecificOutput?: { permissionDecision?: string };
    };
    const codex = parseHookOutput(formatAgentHookResponse("codex", "PreToolUse", "warn", "approval required")) as {
      systemMessage?: string;
    };

    expect(claude.hookSpecificOutput?.permissionDecision).toBe("ask");
    expect(codex.systemMessage).toContain("Termyte warn:");
  });

  it("installs Claude hooks and verifies them with a live smoke test", () => {
    const cwd = workspace("termyte-claude-install-");
    const result = installAgentHooks("claude", cwd);
    const verification = verifyAgentHooks("claude", cwd);

    expect(result.installed).toBe(true);
    expect(result.active).toBe(true);
    expect(verification.ok).toBe(true);
    expect(fs.readFileSync(result.path, "utf8")).toContain("agent hook claude");
  });

  it("installs Codex hooks only when live smoke verification passes", () => {
    const cwd = workspace("termyte-codex-install-");
    const result = installAgentHooks("codex", cwd);
    const verification = verifyAgentHooks("codex", cwd);

    expect(result.installed).toBe(true);
    expect(result.active).toBe(true);
    expect(verification.ok).toBe(true);
    expect(result.message).toContain("live smoke test");
    expect(fs.readFileSync(result.path, "utf8")).toContain("agent hook codex");
  });

  it("uninstalls Termyte hook configuration", () => {
    const cwd = workspace("termyte-hook-uninstall-");
    const install = installAgentHooks("codex", cwd);
    const uninstall = uninstallAgentHooks("codex", cwd);

    expect(uninstall.removed).toBe(true);
    expect(fs.existsSync(install.path)).toBe(false);
    expect(verifyAgentHooks("codex", cwd).ok).toBe(false);
  });
});
