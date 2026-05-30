import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseAction } from "../src/parser.js";
import { openDatabase } from "../src/db.js";
import { MemoryEngine } from "../src/memory.js";
import { Ledger } from "../src/ledger.js";
import { resolveTargets } from "../src/resolver.js";
import { analyzeRisk } from "../src/risk.js";
import { evaluatePolicies } from "../src/policy.js";
import { inspectAction, runRuntime } from "../src/runtime.js";

describe("runtime parsing and risk", () => {
  it("blocks wildcard recursive deletes", () => {
    const action = parseAction("rm -rf *");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);
    const policy = evaluatePolicies(action, risk);

    expect(action.semanticId).toBe("filesystem.delete.recursive.force.wildcard");
    expect(risk.decision).toBe("block");
    expect(policy.decision).toBe("block");
  });

  it("blocks powershell recursive deletes", () => {
    const action = parseAction("Remove-Item -Recurse -Force *");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(action.kind).toBe("filesystem.delete");
    expect(risk.decision).toBe("block");
  });

  it("warns on force push", () => {
    const action = parseAction("git push --force origin feature");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(action.semanticId).toBe("git.push.force");
    expect(risk.decision).toBe("warn");
  });

  it("warns on package publish", () => {
    const action = parseAction("npm publish");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(action.semanticId).toBe("package.npm.publish");
    expect(risk.decision).toBe("warn");
  });

  it("blocks SQL destructive strings", () => {
    const drop = parseAction('sqlite3 db.sqlite "DROP TABLE users;"');
    const dropRisk = analyzeRisk(drop, resolveTargets(drop, process.cwd()));
    const deleteNoWhere = parseAction('psql -c "DELETE FROM users;"');
    const deleteNoWhereRisk = analyzeRisk(deleteNoWhere, resolveTargets(deleteNoWhere, process.cwd()));
    const deleteWithWhere = parseAction('psql -c "DELETE FROM users WHERE id = 1;"');
    const deleteWithWhereRisk = analyzeRisk(deleteWithWhere, resolveTargets(deleteWithWhere, process.cwd()));

    expect(dropRisk.decision).toBe("block");
    expect(deleteNoWhereRisk.decision).toBe("block");
    expect(deleteWithWhereRisk.decision).toBe("warn");
  });

  it("allows a single file delete", () => {
    const action = parseAction("rm file.txt");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(risk.decision).toBe("allow");
  });

  it("warns on node_modules delete but does not hard block it", () => {
    const action = parseAction("rm -rf node_modules");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(risk.decision).not.toBe("block");
    expect(["warn", "allow"]).toContain(risk.decision);
  });

  it("flags sensitive targets", () => {
    const gitAction = parseAction("rm -rf .git");
    const srcAction = parseAction("rm src");
    const envAction = parseAction("rm .env");
    const nestedGitAction = parseAction("rm -rf .git/hooks");
    const nestedSourceAction = parseAction("rm src/index.ts");
    const nestedBuildAction = parseAction("rm dist/assets");
    const nestedConfigAction = parseAction("rm .env.local");

    const gitTargets = resolveTargets(gitAction, process.cwd());
    const srcTargets = resolveTargets(srcAction, process.cwd());
    const envTargets = resolveTargets(envAction, process.cwd());
    const nestedGitTargets = resolveTargets(nestedGitAction, process.cwd());
    const nestedSourceTargets = resolveTargets(nestedSourceAction, process.cwd());
    const nestedBuildTargets = resolveTargets(nestedBuildAction, process.cwd());
    const nestedConfigTargets = resolveTargets(nestedConfigAction, process.cwd());

    expect(gitTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(srcTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(envTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(nestedGitTargets.protectedTargets.length).toBeGreaterThan(0);
    expect(nestedGitTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(nestedSourceTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(nestedBuildTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(nestedConfigTargets.sensitiveTargets.length).toBeGreaterThan(0);
    expect(analyzeRisk(nestedGitAction, nestedGitTargets).decision).toBe("block");
    expect(analyzeRisk(nestedSourceAction, nestedSourceTargets).decision).toBe("warn");
    expect(analyzeRisk(nestedBuildAction, nestedBuildTargets).decision).toBe("warn");
    expect(analyzeRisk(nestedConfigAction, nestedConfigTargets).decision).toBe("warn");
  });

  it("blocks repository metadata directories like .github", () => {
    const action = parseAction("Remove-Item -Recurse -Force .github");
    const targets = resolveTargets(action, process.cwd());
    const risk = analyzeRisk(action, targets);

    expect(targets.protectedTargets.length).toBeGreaterThan(0);
    expect(risk.decision).toBe("block");
  });

  it("treats slash-prefixed rm targets as paths, not flags", () => {
    const rootAction = parseAction("rm /");
    const windowsAction = parseAction("rm -rf /Windows");
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-slash-target-"));

    expect(rootAction.target).toBe("/");
    expect(windowsAction.target).toBe("/Windows");
    expect(analyzeRisk(rootAction, resolveTargets(rootAction, workspaceRoot)).decision).toBe("block");
    expect(analyzeRisk(windowsAction, resolveTargets(windowsAction, workspaceRoot)).decision).toBe("block");
  });

  it("writes ledger and memory entries for allowed commands", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-test-"));
    const dbPath = path.join(workspaceRoot, "termyte.db");

    const result = await runRuntime({
      command: "echo runtime smoke",
      cwd: workspaceRoot,
      dbPath,
      approval: async () => true,
      env: { ...process.env },
    });

    const ctx = openDatabase(dbPath);
    const ledger = new Ledger(ctx.db);
    const memory = new MemoryEngine(ctx.db);

    expect(result.exitCode).toBe(0);
    expect(ledger.listLatest(1)[0]?.semanticId).toBe("shell.generic");
    expect(memory.list(1)[0]?.semanticId).toBe("shell.generic");
    expect(memory.list(1)[0]?.totalCount).toBe(1);
  });

  it("redacts secrets before ledger persistence", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-redact-"));
    const dbPath = path.join(workspaceRoot, "termyte.db");
    const secretCommand = "echo ok --token abc123 password=secret123 OPENAI_API_KEY=sk-test Authorization: Bearer xyz";

    const result = await runRuntime({
      command: secretCommand,
      cwd: workspaceRoot,
      dbPath,
      approval: async () => true,
      env: { ...process.env },
    });

    const ctx = openDatabase(dbPath);
    const ledger = new Ledger(ctx.db);
    const entry = ledger.listLatest(1)[0];

    expect(result.exitCode).toBe(0);
    expect(entry?.rawCommand).toContain("[REDACTED]");
    expect(entry?.redactedCommand).toContain("[REDACTED]");
    expect(entry?.rawCommand).toBe(entry?.redactedCommand);
    expect(entry?.rawCommand).not.toContain("abc123");
    expect(entry?.rawCommand).not.toContain("secret123");
    expect(entry?.rawCommand).not.toContain("sk-test");
    expect(entry?.rawCommand).not.toContain("xyz");
  });

  it("matches similar destructive-delete memory fuzzily", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-fuzzy-"));
    fs.mkdirSync(path.join(workspaceRoot, "src"));

    await runRuntime({
      command: "rm -rf src",
      cwd: workspaceRoot,
      approval: async () => true,
      env: { ...process.env },
    });

    const inspection = inspectAction("Remove-Item -Recurse -Force *", workspaceRoot);

    expect(inspection.memoryMatches.length).toBeGreaterThan(0);
    expect(inspection.memoryMatches[0]?.score).toBeGreaterThanOrEqual(0.7);
    expect(inspection.memoryMatches[0]?.matchedBecause).toContain("same domain and operation");
  });

  it("marks false positives safe and downgrades future block impact", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-safe-"));
    fs.mkdirSync(path.join(workspaceRoot, "src"));
    const dbPath = path.join(workspaceRoot, "termyte.db");

    await runRuntime({
      command: "rm -rf src",
      cwd: workspaceRoot,
      dbPath,
      approval: async () => true,
      env: { ...process.env },
    });

    const ctx = openDatabase(dbPath);
    const memory = new MemoryEngine(ctx.db);
    const latest = memory.list(1)[0];
    expect(latest?.lastOutcome).toBe("blocked");

    const marked = memory.markSafe(latest?.memoryId ?? 0);
    expect(marked?.falsePositiveCount).toBeGreaterThan(0);
    expect(marked?.confidence).toBeLessThan(0.7);

    const inspection = inspectAction("rm -rf src", workspaceRoot, dbPath);
    expect(inspection.finalDecision).toBe("warn");
  });
});
