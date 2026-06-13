import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globalPolicyPath, loadPhaseOnePolicies, localPolicyPath, projectPolicyPath } from "../src/policy-loader.js";
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

  it("uses local policy mode over global mode", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-mode-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.mkdirSync(process.env.TERMYTE_HOME, { recursive: true });
    fs.writeFileSync(globalPolicyPath(), "version: 1\nmode: observe\npresets: []\nrules: []\n", "utf8");
    fs.writeFileSync(localPolicyPath(workspace), "version: 1\nmode: strict\npresets: []\nrules: []\n", "utf8");

    const effective = mergePhaseOnePolicies(loadPhaseOnePolicies(workspace));

    expect(effective.mode).toBe("strict");
  });

  it("loads project termyte.yaml compatibility policy files", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-project-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.writeFileSync(projectPolicyPath(workspace), [
      "version: 1",
      "mode: strict",
      "protectedBranches:",
      "  - main",
      "protectedPaths:",
      "  - src/auth/**",
      "secrets:",
      "  blockRead:",
      "    - .env.production",
      "commands:",
      "  block:",
      "    - \"npm publish\"",
      "  warn:",
      "    - \"npm install\"",
      "allow:",
      "  commands:",
      "    - \"npm test\"",
      "",
    ].join("\n"), "utf8");

    const loaded = loadPhaseOnePolicies(workspace);
    const effective = mergePhaseOnePolicies(loaded);

    expect(effective.layers[2]).toMatchObject({ name: "local", loaded: true, path: projectPolicyPath(workspace), mode: "strict" });
    expect(effective.mode).toBe("strict");
    expect(effective.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "warn protected project paths", action: "warn", source: "local" }),
      expect.objectContaining({ name: "block configured secret reads", action: "block", source: "local" }),
      expect.objectContaining({ name: "block configured commands", action: "block", source: "local" }),
      expect.objectContaining({ name: "warn configured commands", action: "warn", source: "local" }),
      expect.objectContaining({ name: "allow configured commands", action: "allow", source: "local" }),
    ]));
    expect(effective.rules.find((rule) => rule.name === "warn configured commands")?.match.commands).toContain("npm install *");
    expect(effective.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining("protectedBranches"),
    ]));
  });

  it("prefers termyte.policy.yaml when both local policy file names exist", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-precedence-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.writeFileSync(localPolicyPath(workspace), "version: 1\nmode: observe\npresets: []\nrules: []\n", "utf8");
    fs.writeFileSync(projectPolicyPath(workspace), "version: 1\nmode: strict\ncommands:\n  block:\n    - \"npm publish\"\n", "utf8");

    const effective = mergePhaseOnePolicies(loadPhaseOnePolicies(workspace));

    expect(effective.layers[2]).toMatchObject({ loaded: true, path: localPolicyPath(workspace), mode: "observe" });
    expect(effective.mode).toBe("observe");
    expect(effective.rules).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "block configured commands" })]));
  });

  it("fails invalid present policy files", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-loader-invalid-"));
    process.env.TERMYTE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-home-"));
    fs.writeFileSync(localPolicyPath(workspace), "version: 1\npresets:\n  - missing\nrules: []\n", "utf8");

    expect(() => loadPhaseOnePolicies(workspace)).toThrow(/unknown preset/);
  });
});
