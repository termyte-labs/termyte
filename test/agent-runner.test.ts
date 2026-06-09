import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildAgentRunPlan } from "../src/agent.js";
import { formatAgentStartupBanner, prepareAgentRun, runAgent } from "../src/agent-runner.js";

function makeExecutable(directory: string, name: string, sideEffectPath?: string): string {
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

describe("direct agent launcher", () => {
  it("prepares a direct-launch runtime and banner", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launcher-"));
    const readiness = prepareAgentRun(workspace);
    const plan = buildAgentRunPlan({
      workspaceRoot: workspace,
      dbPath: readiness.dbPath,
      agentName: "codex",
      agentArgs: [],
      originalPath: process.env.PATH ?? "",
      platform: process.platform,
    });
    const banner = formatAgentStartupBanner(plan, readiness);

    expect(readiness.runtimeMode).toBe("direct");
    expect(fs.existsSync(readiness.dbPath)).toBe(true);
    expect(banner).toContain("Termyte Agent Launcher");
    expect(banner).toContain("Launch mode:");
    expect(banner).toContain("direct");
    expect(banner).toContain("Governed command inspection lives in `termyte run -- <command>` and `termyte mcp serve`.");
  });

  it("launches the resolved executable directly", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launcher-run-"));
    const binDir = path.join(workspace, "bin");
    fs.mkdirSync(binDir);
    const sentinel = path.join(workspace, "agent-ran.txt");
    makeExecutable(binDir, "codex", sentinel);
    const plan = buildAgentRunPlan({
      workspaceRoot: workspace,
      dbPath: path.join(workspace, "termyte.db"),
      agentName: "codex",
      agentArgs: [sentinel],
      originalPath: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      platform: process.platform,
    });

    const result = await runAgent(plan);

    expect(result.exitCode).toBe(0);
    expect(result.launched).toBe(true);
    expect(result.readiness?.runtimeMode).toBe("direct");
    expect(fs.existsSync(sentinel)).toBe(true);
  });

  it("fails cleanly when an executable is missing", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launcher-missing-"));
    const plan = buildAgentRunPlan({
      workspaceRoot: workspace,
      dbPath: path.join(workspace, "termyte.db"),
      agentName: "codex",
      agentArgs: [],
      originalPath: workspace,
      platform: process.platform,
    });

    const result = await runAgent(plan);

    expect(result.exitCode).toBe(1);
    expect(result.launched).toBe(false);
  });
});
