import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import { MemoryEngine } from "../src/memory.js";
import { runRuntime } from "../src/runtime.js";

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd,
    env: { ...process.env, TERMYTE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-")), INIT_CWD: cwd },
    encoding: "utf8",
  });
}

describe("SQLite logs and memory", () => {
  it("shows empty ledger and memory views without JSONL state", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-empty-state-"));

    const logs = runCli(["logs"], workspace);
    const memory = runCli(["memory"], workspace);

    expect(logs.status).toBe(0);
    expect(memory.status).toBe(0);
    expect(logs.stdout).toContain("(empty)");
    expect(memory.stdout).toContain("(empty)");
    expect(fs.existsSync(path.join(workspace, ".termyte", "logs.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".termyte", "memory.jsonl"))).toBe(false);
  });

  it("records check actions in the sqlite ledger", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-check-ledger-"));
    const result = runCli(["check", "git push --force origin main"], workspace);
    const ctx = openDatabase(path.join(workspace, ".termyte", "termyte.db"));
    const ledger = new Ledger(ctx.db);

    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout) as { decision: string; semantic_id: string; executed: boolean };
    expect(parsed).toMatchObject({ decision: "block", semantic_id: "git.push.force", executed: false });
    expect(ledger.listLatest(1)[0]?.semanticId).toBe("git.push.force");
  });

  it("records runtime actions in the sqlite ledger and memory store", async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-runtime-ledger-"));
    const dbPath = path.join(workspace, ".termyte", "termyte.db");

    const result = await runRuntime({
      command: "echo runtime smoke",
      cwd: workspace,
      dbPath,
      approval: async () => true,
      env: { ...process.env },
    });

    const ctx = openDatabase(dbPath);
    const ledger = new Ledger(ctx.db);
    const memory = new MemoryEngine(ctx.db);

    expect(result.wasExecuted).toBe(true);
    expect(ledger.listLatest(1)[0]?.semanticId).toBe("shell.generic");
    expect(memory.list(1)[0]?.semanticId).toBe("shell.generic");
    expect(runCli(["logs", "--json"], workspace).stdout).toContain("shell.generic");
    expect(runCli(["memory", "--json"], workspace).stdout).toContain("shell.generic");
  });

  it("stores repo-safe memory overrides and one-time approvals without executing them", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-approvals-"));

    const safeResult = runCli(["mark-safe", "npm install zod"], workspace);
    const approvalResult = runCli(["allow-once", "git status"], workspace);
    const approvalsPath = path.join(workspace, ".termyte", "approvals.json");
    const approvals = JSON.parse(fs.readFileSync(approvalsPath, "utf8")) as { approvals: Array<{ command: string; used_at: string | null }> };

    expect(safeResult.status).toBe(0);
    expect(safeResult.stdout).toContain("Stored safe command memory.");
    expect(approvalResult.status).toBe(0);
    expect(approvalResult.stdout).toContain("Stored one-time approval.");
    expect(fs.existsSync(approvalsPath)).toBe(true);
    expect(approvals.approvals[0]?.command).toContain("git status");
    expect(runCli(["approvals"], workspace).stdout).toContain("git status");
  });
});
