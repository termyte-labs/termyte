import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function runCli(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd,
    env: { ...process.env, TERMYTE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-")), ...extraEnv },
    encoding: "utf8",
  });
}

describe("Phase 2 logs and memory", () => {
  it("empty logs output does not crash", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-logs-empty-"));
    const result = runCli(["logs"], workspace);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Recent Termyte events");
    expect(result.stdout).toContain("No events yet.");
  });

  it('check "cat .env" writes a block log event', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-logs-block-"));
    const result = runCli(["check", "cat .env", "--json"], workspace);
    const logsPath = path.join(workspace, ".termyte", "logs.jsonl");

    expect(result.status).toBe(1);
    const rows = fs.readFileSync(logsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "block", command: "cat .env" });
  });

  it('check "npm publish" writes a warn log event', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-logs-warn-"));
    const result = runCli(["check", "npm publish", "--json"], workspace);
    const logsPath = path.join(workspace, ".termyte", "logs.jsonl");

    expect(result.status).toBe(0);
    const rows = fs.readFileSync(logsPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ decision: "warn", command: "npm publish" });
  });

  it("logs filters blocked and warned events", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-logs-filters-"));
    runCli(["check", "cat .env", "--json"], workspace);
    runCli(["check", "npm publish", "--json"], workspace);

    const blocked = runCli(["logs", "--blocked"], workspace);
    const warned = runCli(["logs", "--warned"], workspace);

    expect(blocked.stdout).toContain("[BLOCK] cat .env");
    expect(blocked.stdout).not.toContain("[WARN] npm publish");
    expect(warned.stdout).toContain("[WARN] npm publish");
    expect(warned.stdout).not.toContain("[BLOCK] cat .env");
  });

  it("logs --json returns valid JSON", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-logs-json-"));
    runCli(["check", "npm publish", "--json"], workspace, { TERMYTE_AGENT: "codex" });
    const result = runCli(["logs", "--json"], workspace);
    const parsed = JSON.parse(result.stdout) as Array<{ decision: string; agent?: string }>;

    expect(result.status).toBe(0);
    expect(parsed[0]).toMatchObject({ decision: "warn", agent: "codex" });
  });

  it("empty memory output does not crash", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-empty-"));
    const result = runCli(["memory"], workspace);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Termyte Memory");
    expect(result.stdout).toContain("Unsafe patterns:");
    expect(result.stdout).toContain("Safe patterns:");
  });

  it('mark-safe "npm test" stores safe memory', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-safe-"));
    const result = runCli(["mark-safe", "npm test"], workspace);
    const memoryPath = path.join(workspace, ".termyte", "memory.jsonl");
    const rows = fs.readFileSync(memoryPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));

    expect(result.status).toBe(0);
    expect(rows[0]).toMatchObject({ type: "safe", pattern: "npm test" });
  });

  it('mark-unsafe "npm publish" stores unsafe memory', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-unsafe-"));
    const result = runCli(["mark-unsafe", "npm publish"], workspace);
    const memoryPath = path.join(workspace, ".termyte", "memory.jsonl");
    const rows = fs.readFileSync(memoryPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));

    expect(result.status).toBe(0);
    expect(rows[0]).toMatchObject({ type: "unsafe", pattern: "npm publish" });
  });

  it("memory lists stored records", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-list-"));
    runCli(["mark-safe", "npm test"], workspace);
    runCli(["mark-unsafe", "npm publish"], workspace);
    const result = runCli(["memory"], workspace);

    expect(result.stdout).toContain("- npm publish");
    expect(result.stdout).toContain("- npm test");
  });

  it("unsafe memory upgrades allow to warn", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-upgrade-"));
    runCli(["mark-unsafe", "npm test"], workspace);
    const result = runCli(["check", "npm test", "--json"], workspace);
    const parsed = JSON.parse(result.stdout) as { decision: string; reason: string; memory_matches: unknown[] };

    expect(parsed.decision).toBe("warn");
    expect(parsed.reason).toContain("marked unsafe");
    expect(parsed.memory_matches.length).toBeGreaterThan(0);
  });

  it("unsafe memory does not downgrade block", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-block-unsafe-"));
    runCli(["mark-unsafe", "cat .env"], workspace);
    const result = runCli(["check", "cat .env", "--json"], workspace);

    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
  });

  it("safe memory does not downgrade block", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-memory-block-safe-"));
    runCli(["mark-safe", "cat .env"], workspace);
    const result = runCli(["check", "cat .env", "--json"], workspace);

    expect(JSON.parse(result.stdout)).toMatchObject({ decision: "block" });
  });
});
