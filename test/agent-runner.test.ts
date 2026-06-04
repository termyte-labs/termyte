import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist/cli.js");

function makeWorkspace(prefix: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(workspace, ".git"));
  return workspace;
}

function makeFakeAgent(binDir: string, name: string, exitCode = 0): string {
  fs.mkdirSync(binDir, { recursive: true });
  const executable = process.platform === "win32" ? path.join(binDir, `${name}.cmd`) : path.join(binDir, name);
  const content = process.platform === "win32"
    ? `@echo off\r\necho fake-${name}-stdout\r\necho fake-${name}-stderr 1>&2\r\necho session:%TERMYTE_SESSION_ID%\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\necho fake-${name}-stdout\necho fake-${name}-stderr >&2\necho session:$TERMYTE_SESSION_ID\nexit ${exitCode}\n`;
  fs.writeFileSync(executable, content, "utf8");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  return executable;
}

function runCli(workspace: string, binDir: string, args: string[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-agent-home-"));
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: binDir,
      Path: binDir,
      TERMYTE_HOME: home,
      TERMYTE_ORIGINAL_PATH: "",
    },
    encoding: "utf8",
  });
}

describe("Phase 6 limited agent runner", () => {
  it("fails cleanly when a supported agent executable is missing", () => {
    const workspace = makeWorkspace("termyte-agent-run-missing-");
    const binDir = path.join(workspace, "empty-bin");
    fs.mkdirSync(binDir);

    const result = runCli(workspace, binDir, ["run", "codex"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Termyte could not find the agent executable: codex");
    expect(result.stderr).toContain("npm install -g @openai/codex");
    expect(result.stderr).toContain("termyte doctor");
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("resolves claudecode to claude and shows an honest limited banner", () => {
    const workspace = makeWorkspace("termyte-agent-run-alias-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "claude");

    const result = runCli(workspace, binDir, ["run", "claudecode"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Termyte Safe Runtime");
    expect(result.stdout).toContain(`Repo: ${path.basename(workspace)}`);
    expect(result.stdout).toContain("Agent: claudecode");
    expect(result.stdout).toMatch(/Session: tm_[a-f0-9]{12}/);
    expect(result.stdout).toContain("built-in: safe-default");
    expect(result.stdout).toContain("logs: enabled");
    expect(result.stdout).toContain("memory: enabled");
    expect(result.stdout).toContain("Runtime mode:\n  limited");
    expect(result.stdout).toContain("Running:\n  claude");
    expect(result.stdout).toContain("fake-claude-stdout");
    expect(result.stderr).toContain("fake-claude-stderr");
    expect(fs.existsSync(path.join(workspace, ".termyte"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "termyte.policy.yaml"))).toBe(false);
  });

  it("passes session context through stdio and propagates child exit code", () => {
    const workspace = makeWorkspace("termyte-agent-run-exit-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "codex", 7);

    const result = runCli(workspace, binDir, ["run", "codex"]);

    expect(result.status).toBe(7);
    expect(result.stdout).toContain("fake-codex-stdout");
    expect(result.stdout).toMatch(/session:tm_[a-f0-9]{12}/);
    expect(result.stderr).toContain("fake-codex-stderr");
    expect(fs.existsSync(path.join(workspace, ".termyte"))).toBe(true);
  });

  it("does not launch when an existing local policy is invalid", () => {
    const workspace = makeWorkspace("termyte-agent-run-policy-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "aider");
    fs.writeFileSync(path.join(workspace, "termyte.policy.yaml"), "version: 1\nrules:\n  - bad: true\n", "utf8");

    const result = runCli(workspace, binDir, ["run", "aider"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Termyte could not prepare the agent runtime.");
    expect(result.stdout).not.toContain("fake-aider-stdout");
  });
});
