import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compileNaturalLanguagePolicy } from "../src/policy-nl.js";
import { loadPolicyFile, localPolicyPath } from "../src/policy-loader.js";

function expectCompiled(input: string) {
  const result = compileNaturalLanguagePolicy(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.failure.error);
  return result.compiled.rule;
}

function runCli(args: string[], cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-")), home = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-home-"))) {
  return spawnSync(process.execPath, [path.resolve("dist/cli.js"), ...args], {
    cwd,
    env: { ...process.env, TERMYTE_HOME: home, INIT_CWD: cwd },
    encoding: "utf8",
  });
}

describe("Phase 4 natural-language policy compiler", () => {
  it("compiles secret access rules", () => {
    const rule = expectCompiled("Never allow agents to read .env files");

    expect(rule).toMatchObject({
      name: "block-env-file-access",
      action: "block",
      match: {
        semantic_ids: ["secret.access"],
        paths: [".env", ".env.*"],
      },
    });
  });

  it("compiles force push rules", () => {
    const rule = expectCompiled("Block force pushing to main");
    const explicitForceRule = expectCompiled("Never allow git push --force");

    expect(rule).toMatchObject({
      name: "block-git-force-push",
      action: "block",
      match: {
        commands: ["git push --force", "git push -f"],
      },
    });
    expect(explicitForceRule.name).toBe("block-git-force-push");
  });

  it("compiles auth and payment path rules", () => {
    const rule = expectCompiled("Ask before touching auth or payments");

    expect(rule).toMatchObject({
      name: "ask-auth-payment-changes",
      action: "ask",
      match: {
        paths: ["src/auth/**", "src/payments/**", "src/billing/**"],
      },
    });
  });

  it("compiles test deletion rules", () => {
    const rule = expectCompiled("Block agents from deleting tests");

    expect(rule).toMatchObject({
      name: "block-test-deletion",
      action: "block",
      match: {
        semantic_ids: ["filesystem.delete*"],
        paths: ["tests/**", "**tests**/**", "**/*.test.*", "**/*.spec.*"],
      },
    });
  });

  it("compiles package publishing rules", () => {
    const rule = expectCompiled("Warn before npm publish");

    expect(rule).toMatchObject({
      name: "warn-package-publishing",
      action: "warn",
      match: {
        commands: ["npm publish", "pnpm publish", "yarn publish"],
      },
    });
  });

  it("compiles infra deployment rules", () => {
    const rule = expectCompiled("Ask before changing deployment files");

    expect(rule).toMatchObject({
      name: "ask-infra-deployment-changes",
      action: "ask",
      match: {
        paths: [".github/workflows/**", "Dockerfile", "docker-compose.yml", "terraform/**", "k8s/**", "vercel.json", "railway.json"],
      },
    });
  });

  it("compiles destructive database rules", () => {
    const rule = expectCompiled("Block destructive database commands");

    expect(rule).toMatchObject({
      name: "block-destructive-database-commands",
      action: "block",
      match: {
        semantic_ids: ["sql.destructive", "sql.drop-table", "sql.truncate-table", "sql.delete-without-where"],
        commands: ["DROP TABLE", "DROP DATABASE", "TRUNCATE TABLE", "DELETE FROM"],
      },
    });
  });

  it("rejects unsupported and ambiguous rules without compiling", () => {
    const unsupported = compileNaturalLanguagePolicy("Make the agent emotionally intelligent");
    const ambiguous = compileNaturalLanguagePolicy("Warn and block npm publish");

    expect(unsupported.ok).toBe(false);
    expect(ambiguous.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.failure.error).toContain("Unsupported");
    if (!ambiguous.ok) expect(ambiguous.failure.error).toContain("Ambiguous action");
  });
});

describe("Phase 4 natural-language policy CLI", () => {
  it("does not write local policy files during dry-run", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-dry-"));
    const result = runCli(["policy", "local", "add", "Ask before touching auth or payments", "--dry-run"], workspace);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Generated local policy rule");
    expect(result.stdout).toContain("Dry run only. No policy file was changed.");
    expect(fs.existsSync(localPolicyPath(workspace))).toBe(false);
  });

  it("writes local policy files with --yes", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-local-"));
    const result = runCli(["policy", "local", "add", "Ask before touching auth or payments", "--yes"], workspace);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Saved local policy rule");
    const document = loadPolicyFile(localPolicyPath(workspace));
    expect(document.rules).toEqual([
      expect.objectContaining({
        name: "ask-auth-payment-changes",
        action: "ask",
      }),
    ]);
  });

  it("writes global policy files with --yes", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-global-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-home-"));
    const result = runCli(["policy", "global", "add", "Never allow agents to read .env files", "--yes"], workspace, home);
    const document = loadPolicyFile(path.join(home, "policy.yaml"));

    expect(result.status).toBe(0);
    expect(document.rules).toEqual([
      expect.objectContaining({
        name: "block-env-file-access",
        action: "block",
      }),
    ]);
  });

  it("preserves existing presets and rules", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-preserve-"));
    fs.writeFileSync(localPolicyPath(workspace), `version: 1
presets:
  - deploy-guard
rules:
  - name: existing-rule
    action: warn
    match:
      commands:
        - "echo hi"
`, "utf8");

    const result = runCli(["policy", "local", "add", "Warn before npm publish", "--yes"], workspace);
    const document = loadPolicyFile(localPolicyPath(workspace));

    expect(result.status).toBe(0);
    expect(document.presets).toEqual(["deploy-guard"]);
    expect(document.rules.map((rule) => rule.name)).toEqual(["existing-rule", "warn-package-publishing"]);
  });

  it("adds deterministic suffixes for duplicate rule names", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-duplicate-"));

    const first = runCli(["policy", "local", "add", "Warn before npm publish", "--yes"], workspace);
    const second = runCli(["policy", "local", "add", "Warn before npm publish", "--yes"], workspace);
    const document = loadPolicyFile(localPolicyPath(workspace));

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(document.rules.map((rule) => rule.name)).toEqual(["warn-package-publishing", "warn-package-publishing-2"]);
  });

  it("fails unsupported CLI input without writing", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-policy-nl-unsupported-"));
    const result = runCli(["policy", "local", "add", "Make the agent emotionally intelligent", "--yes"], workspace);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Could not compile that policy rule.");
    expect(result.stderr).toContain("No policy file was changed.");
    expect(fs.existsSync(localPolicyPath(workspace))).toBe(false);
  });
});
