import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkCommand } from "../src/check.js";

function runCli(args: string[], cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-cli-"))) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-cli-home-"));
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd,
    env: { ...process.env, TERMYTE_HOME: home, INIT_CWD: cwd },
    encoding: "utf8",
  });
}

describe("Phase 1 check and policy CLI", () => {
  it("prints help for Phase 1 commands", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("termyte check");
    expect(result.stdout).toContain("termyte policy presets");
    expect(result.stdout).toContain("termyte policy show");
    expect(result.stdout).toContain("termyte policy test");
  });

  it("lists built-in presets", () => {
    const result = runCli(["policy", "presets", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { presets: { name: string }[] };
    expect(parsed.presets.map((preset) => preset.name)).toEqual([
      "safe-default",
      "strict-filesystem",
      "git-safe",
      "secrets-guard",
      "deploy-guard",
      "package-manager-safe",
      "ci-safe",
      "dangerous-tools",
    ]);
  });

  it("shows built-in effective policy without config", () => {
    const result = runCli(["policy", "show", "--json"]);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { layers: { name: string; loaded: boolean }[]; presets: string[] };
    expect(parsed.layers).toEqual(expect.arrayContaining([expect.objectContaining({ name: "built-in", loaded: true })]));
    expect(parsed.presets).toContain("safe-default");
  });

  it("shows a product-oriented policies overview", () => {
    const result = runCli(["policies"], fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policies-overview-")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Termyte effective policy");
    expect(result.stdout).toContain("Mode:");
    expect(result.stdout).toContain("Local SQLite policy state");
    expect(result.stdout).toContain("memory database:");
  });

  it("checks commands without executing them", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-check-isolated-"));

    expect(checkCommand("npm test", workspace).decision).toBe("allow");
    expect(checkCommand("npm publish", workspace).decision).toBe("block");
    expect(checkCommand("npm install zod", workspace).decision).toBe("warn");
    expect(checkCommand("cat .env", workspace).decision).toBe("block");
    expect(checkCommand("rm -rf /", workspace).decision).toBe("block");
  });

  it("returns block exit status for blocked policy tests", () => {
    const result = runCli(["policy", "test", "cat .env", "--json"]);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { decision: string; executed: boolean };
    expect(parsed.decision).toBe("block");
    expect(parsed.executed).toBe(false);
  });

  it("does not execute checked commands", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-no-exec-"));
    const sentinel = path.join(workspace, "SHOULD_NOT_EXIST");
    const result = spawnSync(process.execPath, [path.resolve("dist/cli.js"), "check", `node -e \"require('fs').writeFileSync('${sentinel.replace(/\\/g, "\\\\")}','x')\"`, "--json"], {
      cwd: workspace,
      env: { ...process.env, TERMYTE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-cli-home-")) },
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(JSON.parse(result.stdout)).toMatchObject({ executed: false });
  });

  it("accepts inspect without a double-dash and reports the decision", () => {
    const result = runCli(["inspect", "git push --force origin main"], fs.mkdtempSync(path.join(os.tmpdir(), "termyte-inspect-")));

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Final Decision");
    expect(result.stdout).toContain("git.push.force");
    expect(result.stdout).toContain("  - rule:");
    expect(result.stdout).toContain("git.push.force.protected_branch");
    expect(result.stdout).toContain("suggested fix:");
  });

  it("applies project termyte.yaml rules during inspect", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-inspect-project-policy-"));
    fs.writeFileSync(path.join(workspace, "termyte.yaml"), [
      "version: 1",
      "mode: standard",
      "commands:",
      "  block:",
      "    - \"echo blocked\"",
      "",
    ].join("\n"), "utf8");

    const result = runCli(["inspect", "echo blocked", "--json"], workspace);

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { finalDecision: string; matchedPolicies: string[] };
    expect(parsed.finalDecision).toBe("block");
    expect(parsed.matchedPolicies).toContain("local:block configured commands");
  });
});
