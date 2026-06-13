import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDatabase } from "../src/db.js";
import {
  buildAgentRunPlan,
  buildAgentRuntimeMetadata,
  formatAgentDryRunReport,
  isSupportedAgentName,
  parseRunInvocation,
  resolveRuntimeProfile,
  resolveAgentExecutable,
} from "../src/agent.js";
import { runAgent } from "../src/agent-runner.js";

function makeAgentExecutable(directory: string, name: string, sideEffectPath?: string): string {
  const executable = process.platform === "win32" ? path.join(directory, `${name}.cmd`) : path.join(directory, name);
  const script = process.platform === "win32"
    ? [
        "@echo off",
        sideEffectPath ? `echo agent > "%~1"` : "echo agent",
        "exit /b 0",
      ].join("\r\n")
    : [
        "#!/bin/sh",
        sideEffectPath ? "printf agent > \"$1\"" : "printf agent",
      ].join("\n");
  fs.writeFileSync(executable, `${script}\n`, "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(executable, 0o755);
  }
  return executable;
}

describe("agent run planning", () => {
  it("resolves codex and claude through the agent run plan", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-plan-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const codex = makeAgentExecutable(binDir, "codex");
    const claude = makeAgentExecutable(binDir, "claude");
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

    expect(codexPlan.resolvedExecutable).toBe(codex);
    expect(codexPlan.executableFound).toBe(true);
    expect(claudePlan.resolvedExecutable).toBe(claude);
  });

  it("prefers runnable Windows launcher extensions over extensionless npm shims", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-windows-launcher-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const extensionless = path.join(binDir, "codex");
    const cmdLauncher = path.join(binDir, "codex.cmd");
    fs.writeFileSync(extensionless, "#!/bin/sh\nnode cli.js\n", "utf8");
    fs.writeFileSync(cmdLauncher, "@echo off\r\nnode cli.js %*\r\n", "utf8");

    const resolution = resolveAgentExecutable("codex", binDir, "win32", ".COM;.EXE;.BAT;.CMD");

    expect(resolution.resolvedExecutable).toBe(cmdLauncher);
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
      /Unknown agent: bogus\. Supported agents: codex, claude, claudecode\./,
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

  it("describes direct launch mode without interception dependencies", () => {
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
    expect(output).toContain("launch mode: direct");
    expect(output).toContain("enforcement now lives in run -- and MCP");
    expect(output).not.toContain("interception layers");
    expect(output).not.toContain("hook injection");
  });

  it("launches the resolved agent executable directly", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-run-"));
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const sentinel = path.join(workspaceRoot, "agent-ran.txt");
    makeAgentExecutable(binDir, "codex", sentinel);
    const plan = buildAgentRunPlan({
      workspaceRoot,
      dbPath: path.join(workspaceRoot, "termyte.db"),
      agentName: "codex",
      agentArgs: [sentinel],
      originalPath: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      platform: process.platform,
    });

    const result = await runAgent(plan);
    const db = openDatabase(path.join(workspaceRoot, "termyte.db"));
    const metadata = buildAgentRuntimeMetadata(plan);

    expect(result.exitCode).toBe(0);
    expect(result.launched).toBe(true);
    expect(result.readiness?.runtimeMode).toBe("direct");
    expect(fs.existsSync(sentinel)).toBe(true);
    const ledgerCount = db.db.prepare("SELECT COUNT(*) AS count FROM ledger").get() as { count: number };
    expect(ledgerCount.count).toBe(0);
    expect(metadata.runtimeMode).toBe("direct-launch");
    expect(metadata.runtimeNotes[0]).toContain("direct execution plus MCP");
  });

  it("describes the generic default profile behavior", () => {
    const profile = resolveRuntimeProfile("codex", "win32", "default");

    expect(profile.name).toBe("default");
    expect(profile.notes[0]).toContain("Native hooks are optional adapters");
  });

  it("fails gracefully for direct agent launches in non-interactive shells", () => {
    for (const agent of ["codex", "claude"]) {
      const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "run", agent], {
        cwd: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-non-tty-launch-")),
        env: { ...process.env, TERMYTE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-non-tty-home-")) },
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`cannot directly launch ${agent} without an interactive terminal`);
      expect(result.stderr).toContain(`termyte run --dry-run ${agent}`);
    }
  });
});
