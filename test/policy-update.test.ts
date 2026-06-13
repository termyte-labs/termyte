import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectAction, runRuntime } from "../src/runtime.js";
import {
  addPolicies,
  analyzePolicyDrift,
  DEFAULT_POLICY_VERSION,
  defaultPolicies,
  exportPolicyDocument,
  loadPolicyState,
  loadPolicies,
  parsePolicyDocument,
  removePolicies,
  resetPolicies,
  savePolicies,
  validatePolicySet,
} from "../src/policy.js";

describe("policy updates", () => {
  it("persists policy changes in sqlite and loads them back", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-"));
    const dbPath = path.join(workspaceRoot, "termyte.db");

    const saved = savePolicies(dbPath, {
      block: ["shell.generic", "git.push"],
      warn: ["package.*.publish"],
    });
    expect(loadPolicies(dbPath)).toEqual(saved);

    const added = addPolicies(dbPath, "warn", ["sql.delete-with-where", "git.push"]);
    expect(added.warn).toEqual(expect.arrayContaining(["package.*.publish", "sql.delete-with-where", "git.push"]));

    const removed = removePolicies(dbPath, "warn", ["git.push"]);
    expect(removed.warn).not.toContain("git.push");

    const reset = resetPolicies(dbPath);
    expect(reset).toEqual(defaultPolicies);
    expect(loadPolicyState(dbPath).metadata).toMatchObject({
      defaultVersion: DEFAULT_POLICY_VERSION,
      customized: false,
    });
  });

  it("applies stored policies to runtime decisions", async () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-runtime-"));
    const dbPath = path.join(workspaceRoot, "termyte.db");

    savePolicies(dbPath, {
      block: ["shell.generic"],
      warn: [...defaultPolicies.warn],
    });

    const inspection = inspectAction("echo hi", workspaceRoot, dbPath);
    expect(inspection.policy.decision).toBe("block");

    const result = await runRuntime({
      command: "echo hi",
      cwd: workspaceRoot,
      dbPath,
      approval: async () => true,
      env: { ...process.env },
    });

    expect(result.decision).toBe("block");
    expect(result.status).toBe("blocked");
    expect(result.wasExecuted).toBe(false);
  });

  it("exports and imports reviewable policy documents", () => {
    const policies = {
      block: ["shell.generic"],
      warn: ["package.*.publish"],
    };

    const document = exportPolicyDocument(policies, "2026-06-03T00:00:00.000Z");
    expect(document).toEqual({
      version: 1,
      exportedAt: "2026-06-03T00:00:00.000Z",
      defaultPolicyVersion: DEFAULT_POLICY_VERSION,
      policies,
    });

    expect(parsePolicyDocument(JSON.stringify(document))).toEqual(policies);
    expect(parsePolicyDocument(JSON.stringify(policies))).toEqual(policies);
  });

  it("rejects invalid or overbroad policy patterns", () => {
    expect(validatePolicySet({ block: ["*"], warn: ["git push"] })).toEqual([
      'block pattern "*" is too broad; use a narrower semantic pattern',
      'warn pattern "git push" must use only letters, numbers, dot, dash, underscore, and *',
    ]);

    expect(() => savePolicies(path.join(os.tmpdir(), "termyte-invalid-policy.db"), { block: ["*"], warn: [] })).toThrow(/Invalid policy set/);
    expect(() => parsePolicyDocument(JSON.stringify({ block: ["shell.generic"], warn: ["git push"] }))).toThrow(/Invalid policy file/);
  });

  it("tracks default policy drift without overwriting custom policy state", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-drift-"));
    const dbPath = path.join(workspaceRoot, "termyte.db");

    savePolicies(dbPath, {
      block: defaultPolicies.block.filter((rule) => rule !== "package.*.publish"),
      warn: ["filesystem.delete.recursive.force"],
    }, { customized: false, defaultVersion: 1 });

    const state = loadPolicyState(dbPath);
    const drift = analyzePolicyDrift(state);

    expect(state.metadata.customized).toBe(false);
    expect(state.metadata.defaultVersion).toBe(1);
    expect(drift.staleDefaultVersion).toBe(true);
    expect(drift.missingBlockDefaults).toEqual(expect.arrayContaining(["package.*.publish"]));
    expect(drift.missingWarnDefaults).toEqual(expect.arrayContaining(["git.push.force"]));

    addPolicies(dbPath, "warn", ["team.custom.warn"]);
    expect(loadPolicyState(dbPath).metadata.customized).toBe(true);
  });
});
