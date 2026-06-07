import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkNestedShimResolution,
  checkPolicyLoadable,
  checkStaleShimRows,
  evaluateWindowsPathNormalization,
  evaluateWindowsPathext,
  formatDoctorHuman,
  formatDoctorJson,
  optionalAgentCheck,
  resolveBenchmarkFile,
  summarizeChecks,
  type DoctorReport,
} from "../src/doctor.js";
import { defaultPolicies, savePolicies } from "../src/policy.js";
import { createGovernedSession } from "../src/shell.js";

function fakeReport(): DoctorReport {
  const checks = [
    {
      id: "system.node",
      section: "System",
      label: "Node.js",
      status: "PASS" as const,
      message: "Node is usable.",
    },
    {
      id: "workspace.write",
      section: "Workspace",
      label: "Workspace write access",
      status: "FAIL" as const,
      message: "Not writable.",
    },
    {
      id: "agent.claude",
      section: "Tools",
      label: "Claude Code",
      status: "WARN" as const,
      message: "claude is not discoverable.",
    },
  ];
  return {
    generatedAt: "2026-05-30T00:00:00.000Z",
    termyteVersion: "0.0.0-test",
    cwd: "/tmp/termyte",
    platform: "linux",
    arch: "x64",
    summary: summarizeChecks(checks),
    checks,
  };
}

describe("doctor diagnostics", () => {
  it("formats human output with expected sections and statuses", () => {
    const output = formatDoctorHuman(fakeReport());

    expect(output).toContain("Termyte doctor");
    expect(output).toContain("System:");
    expect(output).toContain("Workspace:");
    expect(output).toContain("Tools:");
    expect(output).toContain("PASS Node.js");
    expect(output).toContain("FAIL Workspace write access");
    expect(output).toContain("WARN Claude Code");
  });

  it("formats stable machine-readable JSON", () => {
    const parsed = JSON.parse(formatDoctorJson(fakeReport())) as DoctorReport;

    expect(parsed.summary.fail).toBe(1);
    expect(parsed.checks[0]?.id).toBe("system.node");
    expect(parsed.checks[1]?.status).toBe("FAIL");
  });

  it("represents optional missing agent tools as warnings, not failures", () => {
    const agentChecks = [
      optionalAgentCheck("codex", "Codex CLI", null),
      optionalAgentCheck("claude", "Claude Code", null),
    ];

    expect(agentChecks.length).toBeGreaterThan(0);
    expect(agentChecks.every((check) => check.status === "WARN")).toBe(true);
  });

  it("resolves a bundled benchmark file from a packaged layout", () => {
    const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-package-"));
    const benchmarkDir = path.join(packageRoot, "benchmarks");
    fs.mkdirSync(benchmarkDir);
    const benchmarkFile = path.join(benchmarkDir, "commands.json");
    fs.writeFileSync(benchmarkFile, "[]", "utf8");

    expect(resolveBenchmarkFile(packageRoot, fs.mkdtempSync(path.join(os.tmpdir(), "termyte-cwd-")))).toBe(benchmarkFile);
  });

  it("covers Windows PATH normalization checks with simulated env data", () => {
    const normalized = evaluateWindowsPathNormalization({ Path: "C:\\shim;C:\\bin" }, "win32");
    const duplicated = evaluateWindowsPathNormalization({ Path: "C:\\shim", PATH: "C:\\bin" }, "win32");

    expect(normalized.status).toBe("PASS");
    expect(duplicated.status).toBe("FAIL");
  });

  it("covers Windows PATHEXT checks with simulated env data", () => {
    const healthy = evaluateWindowsPathext({ PATHEXT: ".COM;.EXE;.BAT;.CMD" }, "win32");
    const limited = evaluateWindowsPathext({ PATHEXT: ".EXE" }, "win32");

    expect(healthy.status).toBe("PASS");
    expect(limited.status).toBe("WARN");
  });

  it("reports policy state for a fresh workspace", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-doctor-reliability-"));
    const check = checkPolicyLoadable(workspaceRoot);

    expect(check.id).toBe("workspace.policy_state");
    expect(check.status).toBe("PASS");
  });

  it("reports nested shim resolution for a governed session", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-doctor-nested-shim-"));
    const session = createGovernedSession(workspaceRoot);
    const check = checkNestedShimResolution(session);

    expect(check.id).toBe("shell.nested_shim_resolution");
    expect(check.status).toBe("PASS");
  });

  it("reports stale shim rows for a governed session", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-doctor-stale-rows-"));
    const session = createGovernedSession(workspaceRoot);
    const check = checkStaleShimRows(session);

    expect(check.id).toBe("shell.stale_shim_rows");
    expect(check.status).toBe("PASS");
  });

  it("warns when default-origin policies are stale and missing current defaults", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-doctor-policy-drift-"));
    const dbPath = path.join(workspaceRoot, ".termyte", "termyte.db");
    savePolicies(dbPath, {
      block: [...defaultPolicies.block],
      warn: ["filesystem.delete.recursive.force"],
    }, { customized: false, defaultVersion: 1 });

    const policyCheck = checkPolicyLoadable(workspaceRoot);

    expect(policyCheck?.status).toBe("WARN");
    expect(policyCheck?.message).toContain("default policy version is stale");
  });
});
