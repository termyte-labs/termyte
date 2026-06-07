import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
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

  it("returns Codex deny JSON for destructive Bash calls without hook failure fields", async () => {
    const cwd = workspace("termyte-codex-hook-block-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "codex",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "Bash",
        tool_input: {
          command: "git push --force origin main",
        },
      }),
    });
    const output = parseHookOutput(result.stdout) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
      decision?: string;
    };

    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("block");
    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Termyte block:");
    expect(output.decision).toBeUndefined();
  });

  it("returns only a Codex systemMessage for warn decisions", async () => {
    const cwd = workspace("termyte-codex-hook-warn-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "codex",
      phase: "pre",
      cwd,
      dbPath,
      env: { TERMYTE_SESSION_ID: "tm_test", TERMYTE_DB_PATH: dbPath },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "Bash",
        tool_input: {
          command: "npm publish",
        },
      }),
    });
    const output = parseHookOutput(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("warn");
    expect(Object.keys(output)).toEqual(["systemMessage"]);
    expect(output.systemMessage).toContain("Termyte warn:");
  });

  it("returns empty Codex JSON for allow decisions", async () => {
    const cwd = workspace("termyte-codex-hook-allow-");
    const dbPath = path.join(cwd, "termyte.db");
    const result = await handleAgentHookInvocation({
      agent: "codex",
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

    expect(result.exitCode).toBe(0);
    expect(result.decision).toBe("allow");
    expect(parseHookOutput(result.stdout)).toEqual({});
  });

  it("maps Codex ask decisions to deny", async () => {
    const output = parseHookOutput(formatAgentHookResponse("codex", "PreToolUse", "ask", "approval required")) as {
      hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    };

    expect(output.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput?.permissionDecisionReason).toContain("Termyte block:");
  });

  it("installs and verifies local Codex hook configuration idempotently", () => {
    const cwd = workspace("termyte-codex-install-");
    fs.mkdirSync(path.join(cwd, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codex", "hooks.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                command: "termyte agent hook codex",
                commandWindows: "termyte agent hook codex",
                command_windows: "termyte agent hook codex",
              },
            ],
          },
        ],
      },
    }, null, 2), "utf8");

    const first = installAgentHooks("codex", cwd);
    const second = installAgentHooks("codex", cwd);
    const verification = verifyAgentHooks("codex", cwd);
    const hooks = fs.readFileSync(first.path, "utf8");
    const config = JSON.parse(hooks) as {
      hooks: {
        PreToolUse: Array<{ hooks: Array<Record<string, string>> }>;
        PostToolUse: Array<{ hooks: Array<Record<string, string>> }>;
      };
    };
    const preHook = config.hooks.PreToolUse[0].hooks[0];

    expect(first.path).toBe(path.join(cwd, ".codex", "hooks.json"));
    expect(second.path).toBe(first.path);
    expect(verification.ok).toBe(true);
    expect(preHook.command).toContain(process.execPath.replace(/\\/g, "/"));
    expect(preHook.command).toContain("dist/cli.js");
    expect(preHook.commandWindows).toBe(preHook.command);
    expect(Object.keys(preHook).sort()).toEqual(["command", "commandWindows"]);
    expect(hooks.match(/agent hook codex/g)?.length).toBe(4);
    expect(hooks).not.toContain('"command": "termyte agent hook codex"');
    expect(hooks).not.toContain("command_windows");
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

  it("uninstalls Termyte hook configuration", () => {
    const cwd = workspace("termyte-hook-uninstall-");
    const install = installAgentHooks("codex", cwd);
    const uninstall = uninstallAgentHooks("codex", cwd);

    expect(uninstall.removed).toBe(true);
    expect(fs.existsSync(install.path)).toBe(false);
    expect(verifyAgentHooks("codex", cwd).ok).toBe(false);
  });
});
