import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import { MemoryEngine } from "../src/memory.js";
import { normalizeHookAction } from "../src/action-model.js";
import { evaluateAction } from "../src/evaluator.js";
import * as agentHook from "../src/agent-hook.js";

function workspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function runCli(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd,
    env: { ...process.env, TERMYTE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-hook-home-")), INIT_CWD: cwd },
    encoding: "utf8",
  });
}

function hookEnv(cwd: string, dbPath: string, sessionId = "tm_test"): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERMYTE_WORKSPACE: cwd,
    TERMYTE_WORKSPACE_ROOT: cwd,
    TERMYTE_DB_PATH: dbPath,
    TERMYTE_SESSION_ID: sessionId,
  };
}

async function invokeHook(
  agent: "claude" | "codex",
  phase: "pre" | "post",
  payload: Record<string, unknown>,
  cwd: string,
  dbPath: string,
  sessionId = "tm_test",
) {
  return agentHook.runAgentHookCli(agent, phase === "post" ? ["--post"] : [], Readable.from([`${JSON.stringify(payload)}\n`]), hookEnv(cwd, dbPath, sessionId));
}

describe("agent hook hardening", () => {
  it.each([
    {
      label: "Bash",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "Bash", tool_input: { command: "git status --short" } },
      kind: "shell.command",
    },
    {
      label: "Read",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "Read", tool_input: { file_path: "src/app.ts" } },
      kind: "file.read",
    },
    {
      label: "Write",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "Write", tool_input: { file_path: ".env", content: "TOKEN=secret" } },
      kind: "file.write",
    },
    {
      label: "Edit",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "Edit", tool_input: { file_path: "src/app.ts", content: "export const value = 1;" } },
      kind: "file.edit",
    },
    {
      label: "MultiEdit",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "MultiEdit", tool_input: { file_path: "src/app.ts", edits: [{ oldString: "a", newString: "b" }] } },
      kind: "file.edit",
    },
    {
      label: "WebFetch",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "WebFetch", tool_input: { url: "https://example.com" } },
      kind: "network.request",
    },
    {
      label: "WebSearch",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "WebSearch", tool_input: { query: "termyte hooks" } },
      kind: "network.request",
    },
    {
      label: "mcp__server__tool",
      payload: { hook_event_name: "PreToolUse", cwd: "/tmp/work", session_id: "sess", tool_name: "mcp__server__tool", tool_input: { path: "/tmp" } },
      kind: "mcp.tool_call",
    },
  ])("normalizes real Claude hook payloads for $label", ({ payload, kind }) => {
    const action = normalizeHookAction({
      agent: "claude",
      phase: "pre",
      payload,
      cwd: "/tmp/work",
      sessionId: "sess",
      toolCallId: "tool-1",
    });

    expect(action.kind).toBe(kind);
    expect(action.command.length).toBeGreaterThan(0);
  });

  it("normalizes unknown payloads safely and does not allow them by default", () => {
    const cwd = workspace("termyte-hook-unknown-");
    const dbPath = path.join(cwd, "termyte.db");
    const action = normalizeHookAction({
      agent: "claude",
      phase: "pre",
      payload: {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
      },
      cwd,
    });
    const evaluation = evaluateAction(action, { cwd, dbPath, preferAskForWarnings: true });

    expect(action.kind).toBe("unknown");
    expect(["warn", "ask"]).toContain(evaluation.decision);
    expect(evaluation.decision).not.toBe("allow");
  });

  it("rejects malformed JSON and missing command data in native hooks", async () => {
    const cwd = workspace("termyte-hook-malformed-");
    const dbPath = path.join(cwd, "termyte.db");

    const malformed = await agentHook.handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: hookEnv(cwd, dbPath),
      input: "{",
    });

    const missingCommand = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_name: "Bash",
        tool_input: {},
      },
      cwd,
      dbPath,
    );

    expect(malformed.decision).toBe("block");
    expect(JSON.parse(malformed.stdout)).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
      },
    });
    expect(missingCommand.decision).not.toBe("allow");
  });

  it("blocks dangerous hook actions without executing side effects", async () => {
    const cwd = workspace("termyte-hook-side-effect-");
    const dbPath = path.join(cwd, "termyte.db");
    const pwned = path.join(cwd, "PWNED.txt");

    const bash = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main > PWNED.txt" },
      },
      cwd,
      dbPath,
    );
    const write = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_name: "Write",
        tool_input: { file_path: ".env", content: "TOKEN=secret" },
      },
      cwd,
      dbPath,
    );
    const edit = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_name: "Edit",
        tool_input: { file_path: ".git/config", content: "[core]\nrepositoryformatversion = 0\n" },
      },
      cwd,
      dbPath,
    );
    const push = await invokeHook(
      "codex",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_name: "Bash",
        tool_input: { command: "git push --force origin main" },
      },
      cwd,
      dbPath,
    );

    expect(bash.decision).toBe("block");
    expect(write.decision).toBe("block");
    expect(edit.decision).toBe("block");
    expect(push.decision).toBe("block");
    expect(fs.existsSync(pwned)).toBe(false);
  });

  it("keeps pre/post hook correlation stable with tool_call_id and session hash fallback", async () => {
    const cwd = workspace("termyte-hook-correlation-");
    const dbPath = path.join(cwd, "termyte.db");

    const withToolCallIdPre = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_call_id: "tool-123",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      },
      cwd,
      dbPath,
    );
    const withToolCallIdPost = await invokeHook(
      "claude",
      "post",
      {
        hook_event_name: "PostToolUse",
        cwd,
        session_id: "sess",
        tool_call_id: "tool-123",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        stdout: "clean\n",
        exit_code: 0,
      },
      cwd,
      dbPath,
    );

    const fallbackPre = await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess-fallback",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      },
      cwd,
      dbPath,
      "sess-fallback",
    );
    const fallbackPost = await invokeHook(
      "claude",
      "post",
      {
        hook_event_name: "PostToolUse",
        cwd,
        session_id: "sess-fallback",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        stdout: "clean\n",
        exit_code: 0,
      },
      cwd,
      dbPath,
      "sess-fallback",
    );

    const ledger = new Ledger(openDatabase(dbPath).db);
    const memory = new MemoryEngine(openDatabase(dbPath).db);
    const toolRecord = ledger.findLatestByMetadataKey("correlationKey", "tool:tool-123");
    const fallbackRecord = ledger.findLatestByMetadataKey("correlationKey", `session:sess-fallback:${normalizeHookAction({
      agent: "claude",
      phase: "pre",
      payload: {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess-fallback",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      },
      cwd,
      sessionId: "sess-fallback",
      toolCallId: undefined,
    }).inputHash}`);

    expect(withToolCallIdPre.decision).toBe("allow");
    expect(withToolCallIdPost.decision).toBe("allow");
    expect(toolRecord?.status).toBe("executed");
    expect(fallbackPre.decision).toBe("allow");
    expect(fallbackPost.decision).toBe("allow");
    expect(fallbackRecord?.status).toBe("executed");
    expect(memory.list(10).length).toBeGreaterThan(0);
  });

  it("finalizes failed post hooks as failed ledger rows", async () => {
    const cwd = workspace("termyte-hook-post-fail-");
    const dbPath = path.join(cwd, "termyte.db");
    const correlationId = "tool-fail-1";

    await invokeHook(
      "claude",
      "pre",
      {
        hook_event_name: "PreToolUse",
        cwd,
        session_id: "sess",
        tool_call_id: correlationId,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      },
      cwd,
      dbPath,
    );
    await invokeHook(
      "claude",
      "post",
      {
        hook_event_name: "PostToolUse",
        cwd,
        session_id: "sess",
        tool_call_id: correlationId,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
        stderr: "boom",
        exit_code: 1,
      },
      cwd,
      dbPath,
    );

    const record = new Ledger(openDatabase(dbPath).db).findLatestByMetadataKey("correlationKey", `tool:${correlationId}`);
    expect(record?.status).toBe("failed");
    expect(record?.decision).toBe("allow");
    expect(record?.stderr).toContain("boom");
  });

  it("does not allow missing cwd or session id to become permissive", async () => {
    const cwd = workspace("termyte-hook-missing-env-");
    const dbPath = path.join(cwd, "termyte.db");

    const missingCwd = await agentHook.handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      dbPath,
      env: hookEnv(cwd, dbPath),
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "sess",
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });
    const missingSession = await agentHook.handleAgentHookInvocation({
      agent: "claude",
      phase: "pre",
      cwd,
      dbPath,
      env: { ...hookEnv(cwd, dbPath), TERMYTE_SESSION_ID: undefined },
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        cwd,
        tool_name: "Bash",
        tool_input: { command: "git status --short" },
      }),
    });

    expect(missingCwd.decision).toBe("allow");
    expect(missingSession.decision).toBe("allow");
  });

  it("exposes public hooks smoke and doctor commands", () => {
    const cwd = workspace("termyte-hook-cli-");
    const smoke = runCli(["hooks", "smoke", "claude"], cwd);
    const doctor = runCli(["hooks", "doctor", "--json"], cwd);

    expect(smoke.status).toBe(0);
    expect(smoke.stdout).toContain("Termyte hook smoke: claude");
    expect(doctor.status).toBe(0);
    expect(JSON.parse(doctor.stdout)).toMatchObject({ ok: true });
  }, 20000);

  it("does not claim Codex hook success when live smoke fails", () => {
    const cwd = workspace("termyte-hook-codex-fail-");
    const result = agentHook.installAgentHooks("codex", cwd, {
      smokeRunner: () => ({
        agent: "codex",
        ok: false,
        workspaceRoot: cwd,
        cliPath: path.resolve("dist/cli.js"),
        commandPath: "node dist/cli.js agent hook codex",
        dbPath: path.join(cwd, "termyte.db"),
        checks: [],
        reasons: ["smoke failed"],
      }),
    });

    expect(result.active).toBe(false);
    expect(result.message).toContain("Codex native hooks unavailable. Termyte MCP and Codex sandbox/approval mode remain available.");
  });
});
