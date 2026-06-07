import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import { installAgentHooks } from "../src/agent-hook.js";

const cliPath = path.resolve("dist/cli.js");

function makeWorkspace(prefix: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(workspace, ".git"));
  return workspace;
}

function makeFakeAgent(binDir: string, name: string, exitCode = 0, body?: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const executable = process.platform === "win32" ? path.join(binDir, `${name}.cmd`) : path.join(binDir, name);
  const content = process.platform === "win32"
    ? `@echo off\r\necho fake-${name}-stdout\r\necho fake-${name}-stderr 1>&2\r\necho session:%TERMYTE_SESSION_ID%\r\n${body ?? ""}\r\nexit /b ${exitCode}\r\n`
    : `#!/bin/sh\necho fake-${name}-stdout\necho fake-${name}-stderr >&2\necho session:$TERMYTE_SESSION_ID\n${body ?? ""}\nexit ${exitCode}\n`;
  fs.writeFileSync(executable, content, "utf8");
  if (process.platform !== "win32") fs.chmodSync(executable, 0o755);
  return executable;
}

function makeFakeTool(binDir: string, name: string): string {
  fs.mkdirSync(binDir, { recursive: true });
  const executable = process.platform === "win32" ? path.join(binDir, `${name}.cmd`) : path.join(binDir, name);
  const content = process.platform === "win32"
    ? `@echo off\r\necho fake-${name}:%*\r\nexit /b 0\r\n`
    : `#!/bin/sh\necho fake-${name}:$*\nexit 0\n`;
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
    },
    encoding: "utf8",
  });
}

describe("governed agent runner", () => {
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

  it("resolves claudecode to claude and shows an honest governed banner", () => {
    const workspace = makeWorkspace("termyte-agent-run-alias-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "claude");
    installAgentHooks("claude", workspace);

    const result = runCli(workspace, binDir, ["run", "claudecode"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Termyte Safe Runtime");
    expect(result.stdout).toContain(`Repo: ${path.basename(workspace)}`);
    expect(result.stdout).toContain("Agent: claudecode");
    expect(result.stdout).toMatch(/Session: tm_[a-f0-9]{12}/);
    expect(result.stdout).toContain("built-in: safe-default");
    expect(result.stdout).toContain("logs: enabled");
    expect(result.stdout).toContain("memory: enabled");
    expect(result.stdout).toContain("Runtime mode:\n  intercepted");
    expect(result.stdout).toContain("Termyte is launching the agent inside a governed session.");
    expect(result.stdout).toContain("This is interception, not a full OS sandbox.");
    expect(result.stdout).toContain("Running:\n  claude");
    expect(result.stdout).toContain("fake-claude-stdout");
    expect(result.stderr).toContain("fake-claude-stderr");
    expect(fs.existsSync(path.join(workspace, ".termyte"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "termyte.policy.yaml"))).toBe(false);
  });

  it("routes agent subprocess tools through the governed shim and ledger", () => {
    const workspace = makeWorkspace("termyte-agent-run-governed-");
    const binDir = path.join(workspace, "bin");
    makeFakeTool(binDir, "git");
    makeFakeAgent(binDir, "codex", 0, "git status");
    installAgentHooks("codex", workspace);

    const result = runCli(workspace, binDir, ["run", "codex"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Runtime mode:\n  intercepted");
    expect(result.stdout).toContain("fake-git:status");

    const ledger = new Ledger(openDatabase(path.join(workspace, ".termyte", "termyte.db")).db);
    const records = ledger.replay();
    const launchRecord = records.find((record) => {
      const metadata = JSON.parse(record.metadataJson ?? "{}") as Record<string, unknown>;
      return metadata.runtime === "agent-run" && metadata.agentLaunch === true;
    });
    const shimRecord = records.find((record) => {
      const metadata = JSON.parse(record.metadataJson ?? "{}") as Record<string, unknown>;
      return metadata.runtime === "shell-shim" && metadata.tool === "git";
    });
    const shimMetadata = JSON.parse(shimRecord?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(launchRecord?.decision).toBe("allow");
    expect(shimRecord?.decision).toBe("allow");
    expect(shimRecord?.status).toBe("executed");
    expect(shimMetadata.executedVia).toBe("shell-shim");
    expect(shimMetadata.argv).toEqual(["status"]);
  });

  it("does not launch Codex when native hooks are missing", () => {
    const workspace = makeWorkspace("termyte-agent-run-hooks-missing-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "codex");

    const result = runCli(workspace, binDir, ["run", "codex"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Termyte codex hooks are not ready.");
    expect(result.stderr).toContain("Run: termyte install codex");
    expect(result.stdout).not.toContain("fake-codex-stdout");
    expect(result.stdout).not.toContain("Termyte Safe Runtime");
  });

  it("does not launch Claude when native hooks are stale", () => {
    const workspace = makeWorkspace("termyte-agent-run-hooks-stale-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "claude");
    fs.mkdirSync(path.join(workspace, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".claude", "settings.local.json"), JSON.stringify({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                command: "termyte agent hook claude",
                commandWindows: "termyte agent hook claude",
              },
            ],
          },
        ],
      },
    }, null, 2), "utf8");

    const result = runCli(workspace, binDir, ["run", "claude"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Termyte claude hooks are not ready.");
    expect(result.stderr).toContain("missing PostToolUse handler");
    expect(result.stderr).toContain("Run: termyte install claude");
    expect(result.stdout).not.toContain("fake-claude-stdout");
  });

  it("supports top-level agent shortcuts through the same governed runtime", () => {
    const workspace = makeWorkspace("termyte-agent-run-shortcut-");
    const binDir = path.join(workspace, "bin");
    makeFakeTool(binDir, "git");
    makeFakeAgent(binDir, "codex", 0, "git status");
    installAgentHooks("codex", workspace);

    const result = runCli(workspace, binDir, ["codex"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Runtime mode:\n  intercepted");
    expect(result.stdout).toContain("fake-git:status");

    const ledger = new Ledger(openDatabase(path.join(workspace, ".termyte", "termyte.db")).db);
    const shimRecord = ledger.replay().find((record) => {
      const metadata = JSON.parse(record.metadataJson ?? "{}") as Record<string, unknown>;
      return metadata.runtime === "shell-shim" && metadata.tool === "git";
    });

    expect(shimRecord?.status).toBe("executed");
  });

  it("passes session context through stdio and propagates child exit code", () => {
    const workspace = makeWorkspace("termyte-agent-run-exit-");
    const binDir = path.join(workspace, "bin");
    makeFakeAgent(binDir, "codex", 7);
    installAgentHooks("codex", workspace);

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
    makeFakeAgent(binDir, "codex");
    installAgentHooks("codex", workspace);
    fs.writeFileSync(path.join(workspace, "termyte.policy.yaml"), "version: 1\nrules:\n  - bad: true\n", "utf8");

    const result = runCli(workspace, binDir, ["run", "codex"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Termyte could not prepare the agent runtime.");
    expect(result.stdout).not.toContain("fake-codex-stdout");
  });
});
