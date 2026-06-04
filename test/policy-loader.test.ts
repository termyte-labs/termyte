import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalPolicyPath, loadPhaseOnePolicies, localPolicyPath } from "../src/policy-loader.js";
import { mergePhaseOnePolicies } from "../src/policy-merge.js";

const originalHome = process.env.TERMYTE_HOME;

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.TERMYTE_HOME;
  } else {
    process.env.TERMYTE_HOME = originalHome;
  }
});

describe("Phase 1 policy loader", () => {
  it("loads built-in policy when no global or local files exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));

    const loaded = loadPhaseOnePolicies(workspace);
    const effective = mergePhaseOnePolicies(loaded);

    expect(loaded.layers).toMatchObject([
      { name: "built-in", loaded: true },
      { name: "global", loaded: false },
      { name: "local", loaded: false },
    ]);
    expect(effective.presets).toContain("safe-default");
    expect(effective.rules.some((rule) => rule.source === "built-in")).toBe(true);
    expect(fs.existsSync(globalPolicyPath())).toBe(false);
    expect(fs.existsSync(localPolicyPath(workspace))).toBe(false);
  });

  it("loads global and local YAML policy files", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-local-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.mkdirSync(process.env.TERMYTE_HOME, { recursive: true });
    fs.writeFileSync(globalPolicyPath(), "version: 1\npresets:\n  - deploy-guard\nrules: []\n", "utf8");
    fs.writeFileSync(localPolicyPath(workspace), "version: 1\npresets: []\nrules:\n  - name: local block echo\n    action: block\n    match:\n      commands:\n        - \"echo hi\"\n", "utf8");

    const effective = mergePhaseOnePolicies(loadPhaseOnePolicies(workspace));

    expect(effective.layers).toMatchObject([
      { name: "built-in", loaded: true },
      { name: "global", loaded: true },
      { name: "local", loaded: true },
    ]);
    expect(effective.presets).toContain("deploy-guard");
    expect(effective.rules).toEqual(expect.arrayContaining([expect.objectContaining({ name: "local block echo", source: "local" })]));
  });

  it("fails invalid present policy files", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-invalid-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.writeFileSync(localPolicyPath(workspace), "version: 1\npresets:\n  - missing\nrules: []\n", "utf8");

    expect(() => loadPhaseOnePolicies(workspace)).toThrow(/unknown preset/);
  });
});
