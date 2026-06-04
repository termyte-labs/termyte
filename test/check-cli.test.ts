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

  it("checks commands without executing them", () => {
    expect(checkCommand("npm test").decision).toBe("allow");
    expect(checkCommand("npm publish").decision).toBe("warn");
    expect(checkCommand("cat .env").decision).toBe("block");
    expect(checkCommand("rm -rf /").decision).toBe("block");
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
});
