import fs from "node:fs";
import path from "node:path";
import type { DatabaseContext } from "./db.js";
import { defaultDbPath, openDatabase } from "./db.js";
import { evaluatePolicies, defaultPolicies, type PolicySet } from "./policy.js";
import { parseAction } from "./parser.js";
import { resolveTargets } from "./resolver.js";
import { analyzeRisk } from "./risk.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { executeCommand } from "./execute.js";
import { redactEnvKeys } from "./redact.js";
import type { Decision, InspectionReport, MemoryMatch, ParsedAction } from "./types.js";

export interface RuntimeOptions {
  command: string;
  cwd?: string;
  dbPath?: string;
  dryRun?: boolean;
  stdinIsTTY?: boolean;
  approval?: (prompt: string) => Promise<boolean>;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  env?: NodeJS.ProcessEnv;
  policies?: PolicySet;
}

export interface RuntimeResult {
  exitCode: number;
  status: "executed" | "blocked" | "failed";
  decision: Decision;
  semanticId: string;
  ledgerId: number;
  reason: string;
  stdout: string;
  stderr: string;
  wasExecuted: boolean;
}

function loadWorkspaceRoot(cwd: string): string {
  return path.resolve(cwd);
}

function ensureWorkspace(dbContext?: DatabaseContext, cwd?: string, dbPath?: string): DatabaseContext {
  if (dbContext) return dbContext;
  const workspaceRoot = loadWorkspaceRoot(cwd ?? process.cwd());
  return openDatabase(dbPath ?? defaultDbPath(workspaceRoot));
}

async function maybeApprove(
  decision: Decision,
  reason: string,
  approval: RuntimeOptions["approval"],
  stdout: NodeJS.WriteStream,
): Promise<boolean> {
  if (decision !== "warn") {
    return decision === "allow";
  }

  if (!approval) {
    stdout.write(`WARNING: ${reason}\n`);
    return false;
  }

  return approval(reason);
}

function summarizeMemoryMatches(memoryMatches: MemoryMatch[]): string {
  if (memoryMatches.length === 0) {
    return "no memory matches";
  }

  return memoryMatches
    .map((match) => `${match.semanticId} (${match.lastOutcome}, confidence ${match.confidence.toFixed(2)})`)
    .join("; ");
}

function buildRiskNarrative(
  action: ParsedAction,
  targets: ReturnType<typeof resolveTargets>,
  risk: ReturnType<typeof analyzeRisk>,
  memoryMatches: MemoryMatch[],
): string {
  const targetSummary = targets.targetCount > 0 ? targets.expandedTargets.slice(0, 3).join(", ") : "no resolved targets";
  const danger = risk.signals.length > 0 ? risk.signals.join(", ") : "no specific danger signals";
  const memorySummary = summarizeMemoryMatches(memoryMatches);
  return `${risk.reason}. Semantic danger: ${action.semanticId}. Targets: ${targetSummary}. Blast radius: ${risk.score}. Signals: ${danger}. Memory: ${memorySummary}.`;
}

export async function runRuntime(options: RuntimeOptions): Promise<RuntimeResult> {
  const cwd = loadWorkspaceRoot(options.cwd ?? process.cwd());
  const dbContext = ensureWorkspace(undefined, cwd, options.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  const envKeys = redactEnvKeys(options.env ?? process.env);
  const action = parseAction(options.command);
  const targets = resolveTargets(action, cwd);
  const risk = analyzeRisk(action, targets);
  const policy = evaluatePolicies(action, risk, options.policies ?? defaultPolicies);
  const memoryMatches = memory.findMatches(action, targets);
  const finalDecision = policy.decision;
  const finalReason = buildRiskNarrative(action, targets, risk, memoryMatches);
  const decisionReason = `${policy.reason || risk.reason}. ${finalReason}`;

  const ledgerId = ledger.createPending(action, targets, envKeys, {
    cwd,
    shell: action.shell,
    targets,
    risk,
    policy,
    memoryMatches,
  });

  let outcome;
  if (finalDecision === "block") {
    outcome = {
      status: "blocked" as const,
      exitCode: 1,
      stdout: "",
      stderr: `${decisionReason}\n`,
      durationMs: 0,
    };
  } else if (options.dryRun) {
    outcome = {
      status: "executed" as const,
      exitCode: 0,
      stdout: "Dry run: command not executed.\n",
      stderr: "",
      durationMs: 0,
    };
  } else {
    const approved = await maybeApprove(finalDecision, decisionReason, options.approval, options.stdout ?? process.stdout);
    if (!approved) {
      outcome = {
        status: "blocked" as const,
        exitCode: 1,
        stdout: "",
        stderr: `${decisionReason}\n`,
        durationMs: 0,
      };
    } else {
      outcome = executeCommand(action.rawCommand, action.shell, cwd);
    }
  }

  ledger.finalize(ledgerId, finalDecision, outcome, risk.score, decisionReason);

  try {
    memory.observe(action, finalDecision, outcome, cwd);
  } catch (error) {
    (options.stderr ?? process.stderr).write(`Memory update failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return {
    exitCode: outcome.status === "executed" ? outcome.exitCode ?? 0 : 1,
    status: outcome.status,
    decision: finalDecision,
    semanticId: action.semanticId,
    ledgerId,
    reason: decisionReason,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    wasExecuted: outcome.status === "executed",
  };
}

export function inspectPolicies(policies: PolicySet = defaultPolicies): string {
  return JSON.stringify(policies, null, 2);
}

export function inspectAction(command: string, cwd = process.cwd()): InspectionReport {
  const action = parseAction(command);
  const targets = resolveTargets(action, cwd);
  const risk = analyzeRisk(action, targets);
  const policy = evaluatePolicies(action, risk);
  const memory = new MemoryEngine(openDatabase(defaultDbPath(cwd)).db);
  const memoryMatches = memory.findMatches(action, targets);
  const finalDecision = policy.decision;
  const finalReason = `${policy.reason || risk.reason}. ${buildRiskNarrative(action, targets, risk, memoryMatches)}`;
  return { action, targets, risk, policy, memoryMatches, finalDecision, finalReason };
}
