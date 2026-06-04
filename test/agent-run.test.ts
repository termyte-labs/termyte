import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import {
  buildAgentRunPlan,
  buildAgentRuntimeMetadata,
  formatAgentDryRunReport,
  isSupportedAgentName,
  parseRunInvocation,
  resolveRuntimeProfile,
  resolveAgentExecutable,
} from "../src/agent.js";
import { createGovernedSession, handleGuardRequest, SHELL_HOST_SHIMS } from "../src/shell.js";
import { formatLedger, formatReplay } from "../src/format.js";

function makeAgentExecutable(directory: string, name: string): string {
  const executable = process.platform === "win32" ? path.join(directory, `${name}.cmd`) : path.join(directory, name);
  fs.writeFileSync(executable, "@echo off\r\necho agent\r\n", "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(executable, 0o755);
  }
  return executable;
}

describe("agent run planning", () => {
  it("resolves codex, claude, and aider through the agent run plan", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-plan-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const codex = makeAgentExecutable(binDir, "codex");
    const claude = makeAgentExecutable(binDir, "claude");
    const aider = makeAgentExecutable(binDir, "aider");
    const originalPath = [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);

    const codexPlan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "codex",
      agentArgs: ["--version"],
      originalPath,
      platform: process.platform,
    });
    const claudePlan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "claude",
      agentArgs: ["--version"],
      originalPath,
      platform: process.platform,
    });
    const aiderPlan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "aider",
      agentArgs: ["--version"],
      originalPath,
      platform: process.platform,
    });

    expect(codexPlan.resolvedExecutable).toBe(codex);
    expect(codexPlan.executableFound).toBe(true);
    expect(claudePlan.resolvedExecutable).toBe(claude);
    expect(aiderPlan.resolvedExecutable).toBe(aider);
  });

  it("marks dry-run plans when an agent executable is missing", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-missing-"));
    const plan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "claude",
      agentArgs: ["--version"],
      originalPath: workspaceRoot,
      platform: process.platform,
    });
    const output = formatAgentDryRunReport(plan);

    expect(plan.executableFound).toBe(false);
    expect(output).toContain("resolved executable: claude (not found on PATH)");
    expect(output).toContain("claude executable was not found on PATH");
  });

  it("fails clearly for unknown agents", () => {
    expect(() => parseRunInvocation(["bogus"])).toThrow(
      /Unknown agent: bogus\. Supported agents: codex, claude, claudecode, aider\./,
    );
    expect(isSupportedAgentName("bogus")).toBe(false);
  });

  it("resolves claudecode to claude when only the alias target is available", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-alias-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const claude = makeAgentExecutable(binDir, "claude");

    const resolution = resolveAgentExecutable("claudecode", binDir, process.platform);
    const plan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "claudecode",
      agentArgs: [],
      originalPath: binDir,
      platform: process.platform,
    });

    expect(resolution.attemptedExecutables).toEqual(["claudecode", "claude"]);
    expect(resolution.resolvedAgentName).toBe("claude");
    expect(resolution.resolvedExecutable).toBe(claude);
    expect(plan.resolvedAgentName).toBe("claude");
    expect(formatAgentDryRunReport(plan)).toContain("resolved alias: claudecode -> claude");
  });

  it("prefers a claudecode executable and reports both alias attempts when missing", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-alias-order-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const claudecode = makeAgentExecutable(binDir, "claudecode");
    makeAgentExecutable(binDir, "claude");

    const found = resolveAgentExecutable("claudecode", binDir, process.platform);
    const missing = resolveAgentExecutable("claudecode", workspaceRoot, process.platform);

    expect(found.resolvedAgentName).toBe("claudecode");
    expect(found.resolvedExecutable).toBe(claudecode);
    expect(missing.attemptedExecutables).toEqual(["claudecode", "claude"]);
    expect(missing.resolvedExecutable).toBeNull();
  });

  it("includes profile and shim details in dry-run output", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-dry-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const codex = makeAgentExecutable(binDir, "codex");
    const plan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "codex",
      agentArgs: ["--version"],
      profileName: "codex-windows",
      originalPath: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      platform: process.platform,
    });
    const output = formatAgentDryRunReport(plan);

    expect(output).toContain("profile: codex-windows");
    expect(output).toContain(`resolved executable: ${codex}`);
    expect(output).toContain("enabled shims:");
    expect(output).toContain("disabled shims:");
    expect(output).toContain("shell hooks: disabled");
  });

  it("stores agent metadata in ledger rows for run-launched sessions", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-ledger-"));
    const metadata = buildAgentRuntimeMetadata(
      buildAgentRunPlan({
        workspaceRoot,
        dbPath: path.join(workspaceRoot, "termyte.db"),
        agentName: "codex",
        agentArgs: ["--version"],
        profileName: "codex-windows",
        platform: process.platform,
      }),
    );
    const session = createGovernedSession(workspaceRoot, {
      runtimeMetadata: metadata,
      shimTools: metadata.enabledShims,
    });

    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git status",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["status"],
    });

    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);
    const ledgerMetadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(ledgerMetadata.launchedVia).toBe("termyte-run");
    expect(ledgerMetadata.agentName).toBe("codex");
    expect(ledgerMetadata.agentArgs).toEqual(["--version"]);
    expect(ledgerMetadata.runtimeProfile).toBe("codex-windows");
    expect(ledgerMetadata.shellHooksEnabled).toBe(false);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    expect(formatLedger(ledger.listLatest())).toContain("termyte-run");
    expect(formatReplay(ledger.replay())).toContain("launched via: termyte-run");
  });

  it("keeps high-value shims enabled under the codex Windows profile", () => {
    const profile = resolveRuntimeProfile("codex", "win32", "codex-windows");

    expect(profile.disabledShims).toEqual(SHELL_HOST_SHIMS);
    expect(profile.enabledShims).toEqual(expect.arrayContaining(["git", "npm", "node", "python", "pip", "docker"]));
  });

  it("preserves the generic default profile behavior", () => {
    const profile = resolveRuntimeProfile("codex", "win32", "default");

    expect(profile.name).toBe("default");
    expect(profile.disabledShims).toEqual([]);
    expect(profile.shellHooksEnabled).toBe(true);
    expect(profile.enabledShims).toEqual(expect.arrayContaining(["git", "bash", "cmd"]));
  });
});
