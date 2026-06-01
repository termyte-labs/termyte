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
} from "../src/agent.js";
import { createGovernedSession, handleGuardRequest, SHELL_HOST_SHIMS } from "../src/shell.js";

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
    expect(claudePlan.resolvedExecutable).toBe(claude);
    expect(aiderPlan.resolvedExecutable).toBe(aider);
  });

  it("fails clearly for unknown agents", () => {
    expect(() => parseRunInvocation(["bogus"])).toThrow(
      /Unknown agent: bogus\. Supported agents: codex, claude, aider\./,
    );
    expect(isSupportedAgentName("bogus")).toBe(false);
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
