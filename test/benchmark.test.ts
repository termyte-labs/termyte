import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  loadGovernanceFixture,
  runGovernanceBenchmarks,
  scoreBenchmarkResults,
  validateGovernanceFixture,
  type GovernanceBenchmarkFixture,
} from "../src/benchmark.js";

describe("governance benchmark", () => {
  it("contains 1200 unique, balanced, strictly labeled cases", () => {
    const fixture = loadGovernanceFixture(process.cwd());
    const counts = fixture.cases.reduce<Record<string, number>>((result, entry) => {
      result[entry.expectedDecision] = (result[entry.expectedDecision] ?? 0) + 1;
      return result;
    }, {});

    expect(validateGovernanceFixture(fixture)).toEqual([]);
    expect(fixture.cases).toHaveLength(1200);
    expect(new Set(fixture.cases.map((entry) => entry.id)).size).toBe(1200);
    expect(new Set(fixture.cases.map((entry) => entry.command)).size).toBe(1200);
    expect(counts).toEqual({ allow: 400, warn: 400, block: 400 });
    expect(fixture.cases.every((entry) => entry.rationale && entry.tags.length > 0 && entry.platforms.length > 0)).toBe(true);
  });

  it("generates deterministic fixture output", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-benchmark-generator-"));
    const script = path.resolve("scripts/generate-governance-benchmarks.mjs");
    const first = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });
    const fixturePath = path.join(cwd, "benchmarks", "governance.json");
    const firstOutput = fs.readFileSync(fixturePath, "utf8");
    const second = spawnSync(process.execPath, [script], { cwd, encoding: "utf8" });

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(fixturePath, "utf8")).toBe(firstOutput);
  });

  it("rejects undersized and duplicated fixtures", () => {
    const fixture: GovernanceBenchmarkFixture = {
      version: 2,
      suite: "governance",
      generatedBy: "test",
      cases: [],
    };

    expect(validateGovernanceFixture(fixture)).toContain("fixture must contain more than 1000 cases; found 0");
  });

  it("calculates confusion, false-safe, and overblock metrics", () => {
    const report = scoreBenchmarkResults("governance", "stable-policy-check", [
      { command: "safe", category: "safe", expectedDecisions: ["allow"], actualDecision: "warn", passed: false },
      { command: "warn", category: "warn", expectedDecisions: ["warn"], actualDecision: "allow", passed: false },
      { command: "block", category: "block", expectedDecisions: ["block"], actualDecision: "block", passed: true },
    ]);

    expect(report.summary).toMatchObject({
      total: 3,
      correct: 1,
      falsePositives: 1,
      falseNegatives: 1,
      falseSafe: 1,
      overblocked: 1,
    });
    expect(report.confusionMatrix.allow.warn).toBe(1);
    expect(report.confusionMatrix.warn.allow).toBe(1);
    expect(report.decisions.block.recall).toBe(1);
  });

  it("evaluates the stable policy/check path without writing logs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-governance-bench-"));
    const report = runGovernanceBenchmarks(cwd);

    expect(report.suite).toBe("governance");
    expect(report.engine).toBe("stable-policy-check");
    expect(report.summary.total).toBe(1200);
    expect(fs.existsSync(path.join(cwd, ".termyte", "logs.jsonl"))).toBe(false);
  });
});
