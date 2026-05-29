#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultDbPath, openDatabase } from "./db.js";
import { formatInspection, formatLedger, formatMemory, formatReplay, replayEntries, toJson } from "./format.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { inspectAction, inspectPolicies, runRuntime } from "./runtime.js";
import { defaultPolicies } from "./policy.js";
import { interceptHook, interceptShim, launchGovernedSession } from "./shell.js";
import type { Decision } from "./types.js";

function printUsage(): void {
  console.log(`Usage:
  termyte run -- <command>
  termyte allow-once -- <command>
  termyte mark-safe <memory-id>
  termyte bench [--json]
  termyte logs [--limit N] [--json]
  termyte replay [--json]
  termyte memory [--limit N] [--json]
  termyte policies
  termyte shell [-- <agent>]
  termyte inspect [--json] -- <command>`);
}

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1) return 50;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
}

function hasJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

function commandAfterDoubleDash(args: string[]): string {
  const separatorIndex = args.indexOf("--");
  return separatorIndex >= 0 ? args.slice(separatorIndex + 1).join(" ") : args.slice(1).join(" ");
}

function argsAfterDoubleDash(args: string[]): string[] {
  const separatorIndex = args.indexOf("--");
  return separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);
}

function decisionRank(decision: Decision): number {
  if (decision === "allow") return 0;
  if (decision === "warn") return 1;
  return 2;
}

interface BenchmarkCase {
  command: string;
  category: string;
  expectedDecisions: Decision[];
}

interface BenchmarkResult {
  command: string;
  category: string;
  expectedDecisions: Decision[];
  actualDecision: Decision;
  passed: boolean;
}

function loadBenchmarkCases(cwd: string): BenchmarkCase[] {
  const benchmarkPath = path.join(cwd, "benchmarks", "commands.json");
  if (!fs.existsSync(benchmarkPath)) {
    return [];
  }

  const raw = JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as BenchmarkCase[];
  return raw;
}

function runBenchmarks(cwd: string): {
  summary: {
    total: number;
    correct: number;
    accuracy: number;
    falsePositives: number;
    falseNegatives: number;
  };
  categories: Record<string, { total: number; correct: number; falsePositives: number; falseNegatives: number; accuracy: number }>;
  cases: BenchmarkResult[];
} {
  const cases = loadBenchmarkCases(cwd);
  const tempDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "termyte-bench-")), "bench.db");
  const results: BenchmarkResult[] = cases.map((entry) => {
    const inspection = inspectAction(entry.command, cwd, tempDbPath);
    const actualDecision = inspection.finalDecision;
    const passed = entry.expectedDecisions.includes(actualDecision);
    return {
      command: entry.command,
      category: entry.category,
      expectedDecisions: entry.expectedDecisions,
      actualDecision,
      passed,
    };
  });

  const categories: Record<string, { total: number; correct: number; falsePositives: number; falseNegatives: number; accuracy: number }> = {};
  let correct = 0;
  let falsePositives = 0;
  let falseNegatives = 0;

  for (const result of results) {
    const expectedRanks = result.expectedDecisions.map(decisionRank);
    const minExpected = Math.min(...expectedRanks);
    const maxExpected = Math.max(...expectedRanks);
    const actualRank = decisionRank(result.actualDecision);

    if (result.passed) {
      correct += 1;
    }
    if (!result.passed && actualRank > maxExpected) {
      falsePositives += 1;
    }
    if (!result.passed && actualRank < minExpected) {
      falseNegatives += 1;
    }

    const bucket = categories[result.category] ?? { total: 0, correct: 0, falsePositives: 0, falseNegatives: 0, accuracy: 0 };
    bucket.total += 1;
    if (result.passed) {
      bucket.correct += 1;
    } else if (actualRank > maxExpected) {
      bucket.falsePositives += 1;
    } else if (actualRank < minExpected) {
      bucket.falseNegatives += 1;
    }
    bucket.accuracy = bucket.total > 0 ? bucket.correct / bucket.total : 0;
    categories[result.category] = bucket;
  }

  const total = results.length;
  return {
    summary: {
      total,
      correct,
      accuracy: total > 0 ? correct / total : 0,
      falsePositives,
      falseNegatives,
    },
    categories,
    cases: results,
  };
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "-h" || command === "--help") {
    printUsage();
    return 0;
  }
  const cwd = process.cwd();
  const dbPath = defaultDbPath(cwd);

  if (!command) {
    printUsage();
    return 1;
  }

  if (command === "run") {
    const rawCommand = commandAfterDoubleDash(args);
    if (!rawCommand) {
      console.error("Missing command after `termyte run --`.");
      return 1;
    }

    const approval = async (reason: string): Promise<boolean> => {
      const rl = readline.createInterface({ input, output });
      const answer = (await rl.question(`\n${reason}\nApprove? [y/N] `)).trim().toLowerCase();
      rl.close();
      return answer === "y" || answer === "yes";
    };

    const result = await runRuntime({
      command: rawCommand,
      cwd,
      dbPath,
      approval,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (!result.wasExecuted) {
      process.stderr.write(`termyte ${result.decision}: ${result.semanticId} (${result.reason})\n`);
    }

    return result.exitCode;
  }

  if (command === "shell") {
    if (args.includes("-h") || args.includes("--help")) {
      console.log(`Usage:
  termyte shell
  termyte shell -- <agent>`);
      return 0;
    }

    const agentArgs = argsAfterDoubleDash(args);
    const exitCode = await launchGovernedSession({
      workspaceRoot: cwd,
      agentArgs: agentArgs.length > 0 ? agentArgs : undefined,
    });
    return exitCode;
  }

  if (command === "allow-once") {
    const rawCommand = commandAfterDoubleDash(args);
    if (!rawCommand) {
      console.error("Missing command after `termyte allow-once --`.");
      return 1;
    }

    const result = await runRuntime({
      command: rawCommand,
      cwd,
      dbPath,
      allowOnce: true,
      stdout: process.stdout,
      stderr: process.stderr,
      env: process.env,
    });

    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    if (!result.wasExecuted) {
      process.stderr.write(`termyte ${result.decision}: ${result.semanticId} (${result.reason})\n`);
    }

    return result.exitCode;
  }

  if (command === "mark-safe") {
    const memoryIdValue = Number(args[1]);
    if (!Number.isInteger(memoryIdValue) || memoryIdValue <= 0) {
      console.error("Usage: termyte mark-safe <memory-id>");
      return 1;
    }

    const dbContext = openDatabase(dbPath);
    const memory = new MemoryEngine(dbContext.db);

    const updated = memory.markSafe(memoryIdValue);
    if (!updated) {
      console.error(`No memory entry found for id ${memoryIdValue}.`);
      return 1;
    }

    console.log(
      `Marked memory ${updated.memoryId} as safe. confidence=${updated.confidence.toFixed(2)} false_positive_count=${updated.falsePositiveCount}`,
    );
    return 0;
  }

  if (command === "bench") {
    const report = runBenchmarks(cwd);
    if (hasJsonFlag(args)) {
      console.log(toJson(report));
    } else {
      console.log(`Cases: ${report.summary.total}`);
      console.log(`Accuracy: ${(report.summary.accuracy * 100).toFixed(1)}%`);
      console.log(`False positives: ${report.summary.falsePositives}`);
      console.log(`False negatives: ${report.summary.falseNegatives}`);
      console.log("Category breakdown:");
      for (const [category, stats] of Object.entries(report.categories)) {
        console.log(`  ${category}: ${stats.correct}/${stats.total} correct, fp=${stats.falsePositives}, fn=${stats.falseNegatives}, acc=${(stats.accuracy * 100).toFixed(1)}%`);
      }
    }
    return report.summary.total > 0 ? 0 : 1;
  }

  if (command === "inspect") {
    const rawCommand = commandAfterDoubleDash(args);
    if (!rawCommand) {
      console.error("Missing command after `termyte inspect --`.");
      return 1;
    }

    const inspection = inspectAction(rawCommand, cwd);
    if (hasJsonFlag(args)) {
      console.log(toJson(inspection));
    } else {
      console.log(formatInspection(inspection));
    }
    return 0;
  }

  if (command === "logs") {
    const dbContext = openDatabase(dbPath);
    const ledger = new Ledger(dbContext.db);
    const records = ledger.listLatest(parseLimit(args));
    if (hasJsonFlag(args)) {
      console.log(toJson(records));
    } else {
      console.log(formatLedger(records));
    }
    return 0;
  }

  if (command === "replay") {
    const dbContext = openDatabase(dbPath);
    const ledger = new Ledger(dbContext.db);
    const records = ledger.replay();
    if (hasJsonFlag(args)) {
      console.log(toJson(replayEntries(records)));
    } else {
      console.log(formatReplay(records));
    }
    return 0;
  }

  if (command === "memory") {
    const dbContext = openDatabase(dbPath);
    const memory = new MemoryEngine(dbContext.db);
    const records = memory.list(parseLimit(args));
    if (hasJsonFlag(args)) {
      console.log(toJson(records));
    } else {
      console.log(formatMemory(records));
    }
    return 0;
  }

  if (command === "policies") {
    console.log(inspectPolicies(defaultPolicies));
    return 0;
  }

  if (command === "_shim") {
    const tool = args[1];
    if (!tool) {
      console.error("Missing shim tool name.");
      return 1;
    }
    const toolArgs = args.slice(2);
    return interceptShim(tool, toolArgs);
  }

  if (command === "_hook") {
    const shell = args[1];
    const commandLine = args.slice(2).join(" ");
    if (!shell || !commandLine) {
      console.error("Missing hook shell or command line.");
      return 126;
    }
    return await interceptHook(shell, commandLine);
  }

  printUsage();
  return 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
