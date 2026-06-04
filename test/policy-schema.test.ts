import { describe, expect, it } from "vitest";
import { normalizePhaseOnePolicyDocument, parsePhaseOnePolicyYaml, validateRawPolicyDocument } from "../src/policy-schema.js";
import { presetNames } from "../src/policy-presets.js";

const presets = presetNames();

describe("Phase 1 policy schema", () => {
  it("accepts a minimal valid YAML policy", () => {
    const raw = `
version: 1
presets:
  - safe-default
rules: []
`;

    const document = normalizePhaseOnePolicyDocument(parsePhaseOnePolicyYaml(raw), presets);

    expect(document).toEqual({
      version: 1,
      presets: ["safe-default"],
      rules: [],
    });
  });

  it("accepts rules with semantic, command, and path matchers", () => {
    const raw = `
version: 1
presets:
  - safe-default
rules:
  - name: block env reads
    description: protect local env files
    action: block
    match:
      semantic_ids:
        - secret.access
      commands:
        - "cat .env"
      paths:
        - ".env"
`;

    const document = normalizePhaseOnePolicyDocument(parsePhaseOnePolicyYaml(raw), presets);

    expect(document.rules[0]).toMatchObject({
      name: "block env reads",
      description: "protect local env files",
      action: "block",
      match: {
        semantic_ids: ["secret.access"],
        commands: ["cat .env"],
        paths: [".env"],
      },
    });
  });

  it("rejects unknown fields, versions, actions, presets, and empty matchers", () => {
    expect(validateRawPolicyDocument(parsePhaseOnePolicyYaml("presets: []\nrules: []\n"), presets)).toContain("version must be 1");
    expect(validateRawPolicyDocument(parsePhaseOnePolicyYaml("version: 2\npresets: []\nrules: []\n"), presets)).toContain("version must be 1");
    expect(() => parsePhaseOnePolicyYaml("version: 1\nextra: nope\n")).toThrow(/Unknown policy field/);
    expect(validateRawPolicyDocument(parsePhaseOnePolicyYaml("version: 1\npresets:\n  - nope\nrules: []\n"), presets)).toContain('unknown preset "nope"');
    expect(validateRawPolicyDocument(parsePhaseOnePolicyYaml("version: 1\npresets: []\nrules:\n  - name: bad\n    action: prompt\n    match:\n      semantic_ids:\n        - shell.generic\n"), presets)).toContain("rules[0].action must be one of allow, warn, ask, block");
    expect(validateRawPolicyDocument(parsePhaseOnePolicyYaml("version: 1\npresets: []\nrules:\n  - name: empty\n    action: warn\n    match:\n"), presets)).toContain("rules[0].match must include at least one matcher");
  });

  it("rejects malformed YAML in the supported schema subset", () => {
    expect(() => parsePhaseOnePolicyYaml("version 1\n")).toThrow(/Expected key: value pair/);
  });
});
