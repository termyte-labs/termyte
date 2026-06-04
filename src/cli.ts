#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDatabase } from "./db.js";
import { formatInspection, formatLedger, formatMemory, formatReplay, replayEntries, toJson } from "./format.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { inspectAction, runRuntime } from "./runtime.js";
import {
  addPolicies,
  analyzePolicyDrift,
  DEFAULT_POLICY_VERSION,
  defaultPolicies,
  describePolicies,
  exportPolicyDocument,
  loadPolicyState,
  loadPolicies,
  parsePolicyDocument,
  removePolicies,
  resetPolicies,
  savePolicies,
  validatePolicySet,
  type PolicySet,
} from "./policy.js";
import { interceptHook, interceptShim, launchGovernedSession } from "./shell.js";
import { formatDoctorHuman, formatDoctorJson, runDoctor } from "./doctor.js";
import type { Decision } from "./types.js";
import { buildAgentRunPlan, formatAgentDryRunReport, parseRunInvocation } from "./agent.js";
import { runAgent } from "./agent-runner.js";
import { checkCommand, formatCheckHuman } from "./check.js";
import { buildPolicyAddPlan, formatPolicyPresets, formatPolicyShow, runPolicyTest, savePolicyAddPlan, slimCheckResult } from "./policy-cli.js";
import { formatLocalLogsHuman, listLocalLogs } from "./local-logs.js";
import { formatLocalMemoryHuman, listLocalMemory, storeLocalMemory } from "./local-memory.js";

function printUsage(): void {
  console.log(`Usage:
  termyte check [--json] "<command>"
  termyte policy presets [--json]
  termyte policy show [--json]
  termyte policy test [--json] "<command>"
  termyte policy global add "<natural language rule>" [--dry-run|--yes]
  termyte policy local add "<natural language rule>" [--dry-run|--yes]
  termyte logs [--blocked] [--warned] [--agent <agent>] [--today] [--json]
  termyte memory
  termyte mark-safe "<command>"
  termyte mark-unsafe "<command>"
  termyte run [--dry-run] [--profile <profile>] <agent> [...args]
  termyte run [--dry-run] -- <command>
  termyte allow-once -- <command>
  termyte bench [--json]
  termyte doctor [--json]
  termyte replay [--json]
  termyte policies [--json]
  termyte policies status [--json]
  termyte policies defaults [--json]
  termyte policies reset
  termyte policies set [--block <patterns...>] [--warn <patterns...>]
  termyte policies add <block|warn> <patterns...>
  termyte policies remove <block|warn> <patterns...>
  termyte policies export [--file <path>]
  termyte policies import <path>
  termyte policies validate <path>
  termyte shell [-- <agent>]
  termyte inspect [--json] -- <command>`);
}

function parseLimit(args: string[]): number {
  const index = args.indexOf("--limit");
  if (index === -1) return 50;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 50;
}

function parseLogsFilters(args: string[]): { blocked?: boolean; warned?: boolean; agent?: string; today?: boolean } {
  const agentIndex = args.indexOf("--agent");
  return {
    blocked: args.includes("--blocked"),
    warned: args.includes("--warned"),
    agent: agentIndex >= 0 ? args[agentIndex + 1] : undefined,
    today: args.includes("--today"),
  };
}

function hasJsonFlag(args: string[]): boolean {
  return args.includes("--json");
}

function policyJsonOutput(policies: PolicySet): string {
  return toJson(policies);
}

function parsePolicyKind(value: string): keyof PolicySet | null {
  if (value === "block" || value === "warn") {
    return value;
  }
  return null;
}

function parsePolicySetArgs(args: string[]): { block?: string[]; warn?: string[] } {
  let mode: keyof PolicySet | null = null;
  const block: string[] = [];
  const warn: string[] = [];

  for (const token of args) {
    if (token === "--json") {
      continue;
    }
    if (token === "--block") {
      mode = "block";
      continue;
    }
    if (token === "--warn") {
      mode = "warn";
      continue;
    }
    if (!mode) {
      throw new Error(`Unexpected policy token: ${token}`);
    }
    (mode === "block" ? block : warn).push(token);
  }

  return {
    block: args.includes("--block") ? block : undefined,
    warn: args.includes("--warn") ? warn : undefined,
  };
}

function printPolicySet(policies: PolicySet, json = false): void {
  console.log(json ? policyJsonOutput(policies) : describePolicies(policies));
}

function formatPolicyStatus(dbPath: string, json = false): string {
  const state = loadPolicyState(dbPath);
  const drift = analyzePolicyDrift(state);
  const missingDefaultCount = drift.missingBlockDefaults.length + drift.missingWarnDefaults.length;
  const payload = {
    defaultPolicyVersion: DEFAULT_POLICY_VERSION,
    activeDefaultVersion: state.metadata.defaultVersion,
    customized: state.metadata.customized,
    blockRules: state.policies.block.length,
    warnRules: state.policies.warn.length,
    staleDefaultVersion: drift.staleDefaultVersion,
    missingDefaultCount,
    drift,
  };
  if (json) {
    return toJson(payload);
  }

  return [
    "Termyte policy status",
    `  default policy version: ${payload.defaultPolicyVersion}`,
    `  active default version: ${payload.activeDefaultVersion}`,
    `  customized: ${payload.customized ? "yes" : "no"}`,
    `  rules: ${payload.blockRules} block, ${payload.warnRules} warn`,
    `  stale default version: ${payload.staleDefaultVersion ? "yes" : "no"}`,
    `  missing current default rules: ${payload.missingDefaultCount}`,
    payload.missingDefaultCount > 0
      ? "  next step: run `termyte policies reset` to adopt current defaults, or keep custom policies intentionally."
      : "  next step: none",
  ].join("\n");
}

function parseFileFlag(args: string[], fallbackIndex: number): string | null {
  const fileIndex = args.indexOf("--file");
  if (fileIndex >= 0) {
    return args[fileIndex + 1] ?? null;
  }
  return args[fallbackIndex] && args[fallbackIndex] !== "--json" ? args[fallbackIndex] : null;
}

function commandAfterDoubleDash(args: string[]): string {
  const separatorIndex = args.indexOf("--");
  return separatorIndex >= 0 ? args.slice(separatorIndex + 1).join(" ") : args.slice(1).join(" ");
}

function commandArgument(args: string[], startIndex: number): string {
  return args.slice(startIndex).filter((token) => token !== "--json").join(" ").trim();
}

function naturalLanguagePolicyArgument(args: string[], startIndex: number): string {
  return args.slice(startIndex).filter((token) => token !== "--json" && token !== "--dry-run" && token !== "--yes" && token !== "-y").join(" ").trim();
}

function hasYesFlag(args: string[]): boolean {
  return args.includes("--yes") || args.includes("-y");
}

function argsAfterDoubleDash(args: string[]): string[] {
  const separatorIndex = args.indexOf("--");
  return separatorIndex >= 0 ? args.slice(separatorIndex + 1) : args.slice(1);
}

function decisionRank(decision: Decision): number {
  if (decision === "allow") return 0;
  if (decision === "warn") return 1;
  if (decision === "ask") return 2;
  return 3;
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
  const benchmarkPaths = [
    path.join(cwd, "benchmarks", "commands.json"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "benchmarks", "commands.json"),
  ];

  for (const benchmarkPath of benchmarkPaths) {
    if (fs.existsSync(benchmarkPath)) {
      return JSON.parse(fs.readFileSync(benchmarkPath, "utf8")) as BenchmarkCase[];
    }
  }

  return [];
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

  if (command === "check") {
    const rawCommand = commandArgument(args, 1);
    if (!rawCommand) {
      console.error('Usage: termyte check [--json] "<command>"');
      return 1;
    }
    try {
      const result = checkCommand(rawCommand, cwd);
      if (hasJsonFlag(args)) {
        console.log(toJson(slimCheckResult(result)));
      } else {
        console.log(formatCheckHuman(result));
      }
      return result.decision === "block" ? 1 : 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "logs") {
    try {
      const events = listLocalLogs(cwd, parseLogsFilters(args.slice(1)));
      if (hasJsonFlag(args)) {
        console.log(toJson(events));
      } else {
        console.log(formatLocalLogsHuman(events));
      }
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "memory") {
    try {
      const records = listLocalMemory(cwd);
      if (hasJsonFlag(args)) {
        console.log(toJson(records));
      } else {
        console.log(formatLocalMemoryHuman(records));
      }
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "mark-safe" || command === "mark-unsafe") {
    const rawCommand = commandArgument(args, 1);
    if (!rawCommand) {
      console.error(`Usage: termyte ${command} "<command>"`);
      return 1;
    }
    try {
      const stored = storeLocalMemory(command === "mark-safe" ? "safe" : "unsafe", rawCommand, cwd);
      console.log(`${command === "mark-safe" ? "Marked safe" : "Marked unsafe"}:\n  ${stored.pattern}`);
      return 0;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (command === "policy") {
    const json = hasJsonFlag(args);
    const subcommand = args[1];

    try {
      if (subcommand === "-h" || subcommand === "--help") {
        console.log(`Usage:
  termyte policy presets [--json]
  termyte policy show [--json]
  termyte policy test [--json] "<command>"
  termyte policy global add "<natural language rule>" [--dry-run|--yes]
  termyte policy local add "<natural language rule>" [--dry-run|--yes]`);
        return 0;
      }

      if ((subcommand === "global" || subcommand === "local") && args[2] === "add") {
        const rawRule = naturalLanguagePolicyArgument(args, 3);
        if (!rawRule) {
          console.error(`Usage: termyte policy ${subcommand} add "<natural language rule>" [--dry-run|--yes]`);
          return 1;
        }

        const planResult = buildPolicyAddPlan(subcommand, rawRule, cwd);
        if (!planResult.ok) {
          console.error(planResult.output);
          return 1;
        }

        console.log(planResult.plan.preview);

        if (args.includes("--dry-run")) {
          console.log("");
          console.log("Dry run only. No policy file was changed.");
          return 0;
        }

        if (!hasYesFlag(args)) {
          if (!process.stdin.isTTY) {
            console.error("");
            console.error("Refusing to save without confirmation in non-interactive mode. Use --yes to save or --dry-run to preview.");
            return 1;
          }
          const rl = readline.createInterface({ input, output });
          const answer = (await rl.question("Save this rule? [Y/n] ")).trim().toLowerCase();
          rl.close();
          if (answer && answer !== "y" && answer !== "yes") {
            console.log("No policy file was changed.");
            return 0;
          }
        }

        console.log("");
        console.log(savePolicyAddPlan(planResult.plan));
        return 0;
      }

      if (subcommand === "presets") {
        console.log(formatPolicyPresets(json));
        return 0;
      }

      if (subcommand === "show") {
        console.log(formatPolicyShow(cwd, json));
        return 0;
      }

      if (subcommand === "test") {
        const rawCommand = commandArgument(args, 2);
        if (!rawCommand) {
          console.error('Usage: termyte policy test [--json] "<command>"');
          return 1;
        }
        const result = runPolicyTest(rawCommand, cwd, json);
        console.log(result.output);
        return result.exitCode;
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    console.error("Usage: termyte policy presets | show | test | global add | local add");
    return 1;
  }

  if (command === "run") {
    let invocation;
    try {
      invocation = parseRunInvocation(args.slice(1));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }

    if (invocation.mode === "command") {
      const rawCommand = invocation.command?.join(" ") ?? "";
      if (!rawCommand) {
        console.error("Missing command after `termyte run --`.");
        return 1;
      }

      if (invocation.dryRun) {
        const inspection = inspectAction(rawCommand, cwd, dbPath);
        console.log(formatInspection(inspection));
        return 0;
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

    const agentName = invocation.agentName;
    const agentArgs = invocation.agentArgs;
    if (!agentName) {
      console.error("Missing agent name.");
      return 1;
    }

    const plan = buildAgentRunPlan({
      workspaceRoot: cwd,
      dbPath,
      agentName,
      agentArgs,
      profileName: invocation.profileName,
      originalPath: process.env.PATH ?? "",
    });

    if (invocation.dryRun) {
      console.log(formatAgentDryRunReport(plan));
      return 0;
    }

    return (await runAgent(plan)).exitCode;
  }

  if (command === "shell") {
    if (args.includes("-h") || args.includes("--help")) {
      console.log(`Usage:
  termyte shell
  termyte shell -- <command>`);
      return 0;
    }

    const agentArgs = argsAfterDoubleDash(args);
    if (agentArgs.length === 0 && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      console.error("termyte shell requires an interactive terminal.");
      return 1;
    }

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

  if (command === "_legacy-mark-safe") {
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

  if (command === "doctor") {
    const report = await runDoctor(cwd);
    if (hasJsonFlag(args)) {
      console.log(formatDoctorJson(report));
    } else {
      console.log(formatDoctorHuman(report));
    }
    return report.summary.fail > 0 ? 1 : 0;
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
    const json = hasJsonFlag(args);
    const subcommand = args[1];

    if (!subcommand || subcommand === "--json") {
      printPolicySet(loadPolicies(dbPath), json);
      return 0;
    }

    if (subcommand === "status") {
      console.log(formatPolicyStatus(dbPath, json));
      return 0;
    }

    if (subcommand === "defaults") {
      printPolicySet(defaultPolicies, json);
      return 0;
    }

    if (subcommand === "reset") {
      printPolicySet(resetPolicies(dbPath), json);
      return 0;
    }

    if (subcommand === "export") {
      const exportPath = parseFileFlag(args, 2);
      const document = exportPolicyDocument(loadPolicies(dbPath));
      const outputText = `${toJson(document)}\n`;
      if (exportPath) {
        fs.mkdirSync(path.dirname(path.resolve(exportPath)), { recursive: true });
        fs.writeFileSync(exportPath, outputText, "utf8");
        console.log(`Exported policies to ${path.resolve(exportPath)}`);
      } else {
        console.log(outputText.trimEnd());
      }
      return 0;
    }

    if (subcommand === "import") {
      const importPath = parseFileFlag(args, 2);
      if (!importPath) {
        console.error("Usage: termyte policies import <path>");
        return 1;
      }
      try {
        const next = savePolicies(dbPath, parsePolicyDocument(fs.readFileSync(importPath, "utf8")));
        printPolicySet(next, json);
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    if (subcommand === "validate") {
      const validatePath = parseFileFlag(args, 2);
      if (!validatePath) {
        console.error("Usage: termyte policies validate <path>");
        return 1;
      }
      try {
        const policies = parsePolicyDocument(fs.readFileSync(validatePath, "utf8"));
        const errors = validatePolicySet(policies);
        if (errors.length > 0) {
          console.error(`Invalid policy file: ${errors.join("; ")}`);
          return 1;
        }
        console.log(json ? toJson({ ok: true, policies }) : "Policy file is valid.");
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    if (subcommand === "set") {
      let updates: { block?: string[]; warn?: string[] };
      try {
        updates = parsePolicySetArgs(args.slice(2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        console.error("Usage: termyte policies set [--block <patterns...>] [--warn <patterns...>]");
        return 1;
      }
      if (updates.block === undefined && updates.warn === undefined) {
        console.error("Usage: termyte policies set [--block <patterns...>] [--warn <patterns...>]");
        return 1;
      }

      const current = loadPolicies(dbPath);
      try {
        const next = savePolicies(dbPath, {
          block: updates.block !== undefined ? updates.block : current.block,
          warn: updates.warn !== undefined ? updates.warn : current.warn,
        });
        printPolicySet(next, json);
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    if (subcommand === "add" || subcommand === "remove") {
      const kind = parsePolicyKind(args[2] ?? "");
      const patterns = args.slice(3).filter((token) => token !== "--json");
      if (!kind || patterns.length === 0) {
        console.error(`Usage: termyte policies ${subcommand} <block|warn> <patterns...>`);
        return 1;
      }

      try {
        const next = subcommand === "add" ? addPolicies(dbPath, kind, patterns) : removePolicies(dbPath, kind, patterns);
        printPolicySet(next, json);
        return 0;
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return 1;
      }
    }

    console.error("Usage: termyte policies [--json] | status | defaults | reset | set | add | remove | export | import | validate");
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
