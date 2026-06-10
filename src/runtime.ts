import path from "node:path";
import type { DatabaseContext } from "./db.js";
import { defaultDbPath, openDatabase } from "./db.js";
import { defaultPolicies, type PolicySet } from "./policy.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { executeCommand } from "./execute.js";
import { redactEnvKeys } from "./redact.js";
import { normalizeAction } from "./action-model.js";
import { evaluateAction } from "./evaluator.js";
import type { Decision, InspectionReport } from "./types.js";

export interface RuntimeOptions {
  command: string;
  cwd?: string;
  dbPath?: string;
  dryRun?: boolean;
  allowOnce?: boolean;
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
  if (decision === "allow") {
    return true;
  }

  if (decision !== "warn" && decision !== "ask") {
    return false;
  }

  if (!approval) {
    stdout.write(`WARNING: ${reason}\n`);
    return false;
  }

  return approval(reason);
}

function hasHardCriticalTargets(targets: { protectedTargets: string[]; targetClasses: Array<{ category: string }> }): boolean {
  return targets.protectedTargets.length > 0 || targets.targetClasses.some((entry) => entry.category === "home" || entry.category === "filesystem-root");
}

function resolveAllowOnce(
  decision: Decision,
  reason: string,
  targets: { protectedTargets: string[]; targetClasses: Array<{ category: string }> },
): { decision: Decision; reason: string } {
  if (decision !== "allow" && !hasHardCriticalTargets(targets)) {
    return {
      decision: "allow",
      reason: `${reason} allow-once override applied.`,
    };
  }

  return { decision, reason };
}

export async function runRuntime(options: RuntimeOptions): Promise<RuntimeResult> {
  const cwd = loadWorkspaceRoot(options.cwd ?? process.cwd());
  const dbContext = ensureWorkspace(undefined, cwd, options.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  const envKeys = redactEnvKeys(options.env ?? process.env);
  const action = normalizeAction(options.command, { cwd, source: "runtime" });
  const evaluation = evaluateAction(action, { cwd, dbPath: dbContext.dbPath, applyMemory: true });
  const resolved = options.allowOnce ? resolveAllowOnce(evaluation.decision, evaluation.reason, evaluation.targets) : { decision: evaluation.decision, reason: evaluation.reason };
  const finalDecision = resolved.decision;
  const finalReason = resolved.reason;

  const ledgerId = ledger.createPending(evaluation.parsedAction, evaluation.targets, envKeys, {
    cwd,
    shell: evaluation.parsedAction.shell,
    targets: evaluation.targets,
    risk: evaluation.risk,
    policy: evaluation.policy,
    memoryMatches: evaluation.memoryMatches,
    finalDecision,
    allowOnce: options.allowOnce ?? false,
    safeAlternative: evaluation.safeAlternative,
  });

  let outcome;
  if (finalDecision === "block") {
    outcome = {
      status: "blocked" as const,
      exitCode: 1,
      stdout: "",
      stderr: `${finalReason}\n`,
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
    const approved = finalDecision === "allow"
      ? true
      : await maybeApprove(finalDecision, finalReason, options.approval, options.stdout ?? process.stdout);
    if (!approved) {
      outcome = {
        status: "blocked" as const,
        exitCode: 1,
        stdout: "",
        stderr: `${finalReason}\n`,
        durationMs: 0,
      };
    } else {
      outcome = executeCommand(action.command, evaluation.parsedAction.shell, cwd);
    }
  }

  ledger.finalize(ledgerId, finalDecision, outcome, evaluation.risk.score, finalReason);

  try {
    memory.observe(evaluation.parsedAction, finalDecision, outcome, cwd);
  } catch (error) {
    (options.stderr ?? process.stderr).write(`Memory update failed: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  return {
    exitCode: outcome.status === "executed" ? outcome.exitCode ?? 0 : 1,
    status: outcome.status,
    decision: finalDecision,
    semanticId: evaluation.parsedAction.semanticId,
    ledgerId,
    reason: finalReason,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    wasExecuted: outcome.status === "executed",
  };
}

export function inspectPolicies(policies: PolicySet = defaultPolicies): string {
  return JSON.stringify(policies, null, 2);
}

export function inspectAction(command: string, cwd = process.cwd(), dbPath?: string): InspectionReport {
  const action = normalizeAction(command, { cwd, source: "runtime" });
  const evaluation = evaluateAction(action, { cwd, dbPath, applyMemory: true });
  return {
    action: evaluation.parsedAction,
    targets: evaluation.targets,
    risk: evaluation.risk,
    policy: evaluation.policy,
    memoryMatches: evaluation.memoryMatches,
    finalDecision: evaluation.decision,
    finalReason: evaluation.reason,
    safeAlternative: evaluation.safeAlternative,
    matchedPolicies: evaluation.matchedPolicies,
  };
}
