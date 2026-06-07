import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import {
  handleAgentHookInvocation,
  installAgentHooks,
  verifyAgentHooks,
} from "../src/agent-hook.js";

function workspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function parseHookOutput(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

describe("agent native hook bridge", () => {
  it("denies destructive Claude Bash calls before execution and writes the ledger", async () => {
    const cwd = workspace("termyte-claude-hook-block-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        session_id: "claude-session",
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "Bash",
        tool_input: {
          command: "rm -rf .",
        },
      }),
    });
    const output = parseHookOutput(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    const record = new Ledger(openDatabase(dbPath).db).getById(result.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(result.decision).toBe("block");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(record?.status).toBe("blocked");
    expect(record?.semanticId).toBe("filesystem.delete.recursive.force");
    expect(metadata.runtime).toBe("agent-hook");
    expect(metadata.agentName).toBe("claude");
    expect(metadata.toolName).toBe("Bash");
  });

  it("allows safe Claude Bash calls while still recording delegated execution", async () => {
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
        tool_name: "Bash",
        tool_input: {
          command: "git status --short",
        },
      }),
    });
    const output = parseHookOutput(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };
    const record = new Ledger(openDatabase(dbPath).db).getById(result.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(result.decision).toBe("allow");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("allow");
    expect(record?.status).toBe("executed");
    expect(metadata.delegatedExecution).toBe(true);
  });

  it("denies Claude writes to .env paths", async () => {
    const cwd = workspace("termyte-claude-hook-env-");
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
        tool_name: "Write",
        tool_input: {
          file_path: ".env",
          content: "TOKEN=secret",
        },
      }),
    });
    const output = parseHookOutput(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string } };

    expect(result.decision).toBe("block");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  it("fails closed on invalid hook JSON", async () => {
    const result = await handleAgentHookInvocation({
      agent: "codex",
      phase: "pre",
      cwd: workspace("termyte-codex-hook-invalid-"),
      input: "{not-json",
    });
    const output = parseHookOutput(result.stdout) as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };

    expect(result.decision).toBe("block");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Invalid hook JSON");
  });

  it("installs and verifies local Codex hook configuration idempotently", () => {
    const cwd = workspace("termyte-codex-install-");

    const first = installAgentHooks("codex", cwd);
    const second = installAgentHooks("codex", cwd);
    const verification = verifyAgentHooks("codex", cwd);
    const hooks = fs.readFileSync(first.path, "utf8");

    expect(first.path).toBe(path.join(cwd, ".codex", "hooks.json"));
    expect(second.path).toBe(first.path);
    expect(verification.ok).toBe(true);
    expect(hooks).toContain("node");
    expect(hooks).toContain("cli.js");
    expect(hooks.match(/agent hook codex/g)?.length).toBe(4);
    expect(hooks).not.toContain('"command": "termyte agent hook codex"');
  });

  it("installs and verifies local Claude hook configuration", () => {
    const cwd = workspace("termyte-claude-install-");

    const result = installAgentHooks("claude", cwd);
    const verification = verifyAgentHooks("claude", cwd);
    const hooks = fs.readFileSync(result.path, "utf8");

    expect(result.path).toBe(path.join(cwd, ".claude", "settings.local.json"));
    expect(verification.ok).toBe(true);
    expect(hooks).toContain("agent hook claude");
    expect(hooks).toContain("commandWindows");
    expect(hooks).toContain("PostToolUse");
  });
});
