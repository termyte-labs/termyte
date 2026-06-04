import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectCommand } from "./check.js";
import { inspectAction } from "./runtime.js";
import type { Decision } from "./types.js";

export type GovernanceRiskClass = "safe" | "review-required" | "dangerous";

export interface GovernanceBenchmarkCase {
  id: string;
  command: string;
  category: string;
  expectedDecision: Decision;
  riskClass: GovernanceRiskClass;
  platforms: string[];
  tags: string[];
  source: "generated-template";
  rationale: string;
}

export interface GovernanceBenchmarkFixture {
  version: 2;
  suite: "governance";
  generatedBy: string;
  cases: GovernanceBenchmarkCase[];
}

interface LegacyBenchmarkCase {
  command: string;
  category: string;
  expectedDecisions: Decision[];
}

export interface BenchmarkResult {
  id?: string;
  command: string;
  category: string;
  expectedDecisions: Decision[];
  actualDecision: Decision;
  passed: boolean;
}

export interface BenchmarkDecisionStats {
  expected: number;
  actual: number;
  correct: number;
  precision: number;
  recall: number;
}

export interface BenchmarkReport {
  suite: "governance" | "legacy";
  engine: "stable-policy-check" | "legacy-runtime";
  summary: {
    total: number;
    correct: number;
    accuracy: number;
    falsePositives: number;
    falseNegatives: number;
    falseSafe: number;
    falseSafeRate: number;
    overblocked: number;
    overblockRate: number;
  };
  decisions: Record<Decision, BenchmarkDecisionStats>;
  confusionMatrix: Record<Decision, Record<Decision, number>>;
  categories: Record<string, { total: number; correct: number; falsePositives: number; falseNegatives: number; accuracy: number }>;
  cases: BenchmarkResult[];
}

const decisions: Decision[] = ["allow", "warn", "ask", "block"];

export function validateGovernanceFixture(fixture: GovernanceBenchmarkFixture): string[] {
  const errors: string[] = [];
  if (fixture.version !== 2 || fixture.suite !== "governance") {
    errors.push("fixture must declare governance schema version 2");
  }
  if (fixture.cases.length <= 1000) {
    errors.push(`fixture must contain more than 1000 cases; found ${fixture.cases.length}`);
  }

  const ids = new Set<string>();
  const commands = new Set<string>();
  const counts = new Map<Decision, number>();
  for (const entry of fixture.cases) {
    if (!entry.id || ids.has(entry.id)) errors.push(`duplicate or missing id: ${entry.id || "<missing>"}`);
    if (!entry.command.trim() || commands.has(entry.command)) errors.push(`duplicate or missing command: ${entry.command || "<missing>"}`);
    if (!entry.category || !entry.rationale || entry.tags.length === 0 || entry.platforms.length === 0) {
      errors.push(`case ${entry.id || "<missing>"} is missing category, rationale, tags, or platforms`);
    }
    ids.add(entry.id);
    commands.add(entry.command);
    counts.set(entry.expectedDecision, (counts.get(entry.expectedDecision) ?? 0) + 1);
  }

  for (const decision of ["allow", "warn", "block"] as Decision[]) {
    if ((counts.get(decision) ?? 0) < 300) {
      errors.push(`fixture must contain at least 300 expected ${decision} cases`);
    }
  }
  return errors;
}

export function loadGovernanceFixture(cwd: string): GovernanceBenchmarkFixture {
  const fixturePath = resolveBenchmarkPath(cwd, "governance.json");
  if (!fixturePath) {
    throw new Error("Governance benchmark fixture not found.");
  }
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as GovernanceBenchmarkFixture;
  const errors = validateGovernanceFixture(fixture);
  if (errors.length > 0) {
    throw new Error(`Invalid governance benchmark fixture:\n- ${errors.join("\n- ")}`);
  }
  return fixture;
}

export function runGovernanceBenchmarks(cwd: string): BenchmarkReport {
  const fixture = loadGovernanceFixture(cwd);
  const results = fixture.cases.map((entry): BenchmarkResult => {
    const actualDecision = inspectCommand(entry.command, cwd, { applyMemory: false }).decision;
    return {
      id: entry.id,
      command: entry.command,
      category: entry.category,
      expectedDecisions: [entry.expectedDecision],
      actualDecision,
      passed: actualDecision === entry.expectedDecision,
    };
  });
  return scoreBenchmarkResults("governance", "stable-policy-check", results);
}

export function runLegacyBenchmarks(cwd: string): BenchmarkReport {
  const fixturePath = resolveBenchmarkPath(cwd, "commands.json");
  if (!fixturePath) {
    return scoreBenchmarkResults("legacy", "legacy-runtime", []);
  }
  const cases = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as LegacyBenchmarkCase[];
  const tempDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "termyte-bench-")), "bench.db");
  const results = cases.map((entry): BenchmarkResult => {
    const actualDecision = inspectAction(entry.command, cwd, tempDbPath).finalDecision;
    return {
      command: entry.command,
      category: entry.category,
      expectedDecisions: entry.expectedDecisions,
      actualDecision,
      passed: entry.expectedDecisions.includes(actualDecision),
    };
  });
  return scoreBenchmarkResults("legacy", "legacy-runtime", results);
}

export function scoreBenchmarkResults(
  suite: BenchmarkReport["suite"],
  engine: BenchmarkReport["engine"],
  results: BenchmarkResult[],
): BenchmarkReport {
  const confusionMatrix = emptyConfusionMatrix();
  const decisionStats = emptyDecisionStats();
  const categories: BenchmarkReport["categories"] = {};
  let correct = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let falseSafe = 0;
  let overblocked = 0;

  for (const result of results) {
    const expectedRanks = result.expectedDecisions.map(decisionRank);
    const minExpected = Math.min(...expectedRanks);
    const maxExpected = Math.max(...expectedRanks);
    const actualRank = decisionRank(result.actualDecision);
    const canonicalExpected = result.expectedDecisions[0];

    confusionMatrix[canonicalExpected][result.actualDecision] += 1;
    decisionStats[canonicalExpected].expected += 1;
    decisionStats[result.actualDecision].actual += 1;

    if (result.passed) {
      correct += 1;
      decisionStats[canonicalExpected].correct += 1;
    } else if (actualRank > maxExpected) {
      falsePositives += 1;
    } else if (actualRank < minExpected) {
      falseNegatives += 1;
    }
    if ((canonicalExpected === "block" && result.actualDecision !== "block") || (canonicalExpected === "warn" && result.actualDecision === "allow")) {
      falseSafe += 1;
    }
    if (canonicalExpected === "allow" && result.actualDecision !== "allow") {
      overblocked += 1;
    }

    const bucket = categories[result.category] ?? { total: 0, correct: 0, falsePositives: 0, falseNegatives: 0, accuracy: 0 };
    bucket.total += 1;
    if (result.passed) bucket.correct += 1;
    else if (actualRank > maxExpected) bucket.falsePositives += 1;
    else if (actualRank < minExpected) bucket.falseNegatives += 1;
    bucket.accuracy = bucket.correct / bucket.total;
    categories[result.category] = bucket;
  }

  for (const decision of decisions) {
    const stats = decisionStats[decision];
    stats.precision = stats.actual > 0 ? stats.correct / stats.actual : 0;
    stats.recall = stats.expected > 0 ? stats.correct / stats.expected : 0;
  }

  const total = results.length;
  const expectedUnsafe = results.filter((entry) => entry.expectedDecisions[0] === "warn" || entry.expectedDecisions[0] === "block").length;
  const expectedAllow = decisionStats.allow.expected;
  return {
    suite,
    engine,
    summary: {
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      falsePositives,
      falseNegatives,
      falseSafe,
      falseSafeRate: expectedUnsafe > 0 ? falseSafe / expectedUnsafe : 0,
      overblocked,
      overblockRate: expectedAllow > 0 ? overblocked / expectedAllow : 0,
    },
    decisions: decisionStats,
    confusionMatrix,
    categories,
    cases: results,
  };
}

function resolveBenchmarkPath(cwd: string, name: string): string | null {
  const paths = [
    path.join(cwd, "benchmarks", name),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "benchmarks", name),
  ];
  return paths.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function decisionRank(decision: Decision): number {
  return decisions.indexOf(decision);
}

function emptyConfusionMatrix(): BenchmarkReport["confusionMatrix"] {
  return Object.fromEntries(decisions.map((expected) => [
    expected,
    Object.fromEntries(decisions.map((actual) => [actual, 0])),
  ])) as BenchmarkReport["confusionMatrix"];
}

function emptyDecisionStats(): BenchmarkReport["decisions"] {
  return Object.fromEntries(decisions.map((decision) => [
    decision,
    { expected: 0, actual: 0, correct: 0, precision: 0, recall: 0 },
  ])) as BenchmarkReport["decisions"];
}
