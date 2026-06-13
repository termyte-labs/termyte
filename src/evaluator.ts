import { defaultDbPath, openDatabase } from "./db.js";
import { evaluatePolicies, loadPolicies } from "./policy.js";
import { loadPhaseOnePolicies } from "./policy-loader.js";
import { mergePhaseOnePolicies, strongestDecision, type EffectivePhaseOnePolicy } from "./policy-merge.js";
import { evaluatePhaseOnePolicy } from "./policy-evaluator.js";
import { resolveTargets } from "./resolver.js";
import { analyzeRisk } from "./risk.js";
import { MemoryEngine } from "./memory.js";
import type { Decision, MemoryMatch, ParsedAction, ResolvedTargets, RiskResult } from "./types.js";
import type { RuntimeAction } from "./action-model.js";

export interface EvaluationContext {
  cwd?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  applyMemory?: boolean;
  preferAskForWarnings?: boolean;
}

export interface ActionEvaluation {
  action: RuntimeAction;
  parsedAction: ParsedAction;
  targets: ResolvedTargets;
  risk: RiskResult;
  policy: {
    decision: Decision;
    reason: string;
    matchedPolicy?: string;
    matchedPolicies: string[];
  };
  memoryMatches: MemoryMatch[];
  decision: Decision;
  reason: string;
  safeAlternative: string;
  matchedPolicies: string[];
}

export function evaluateAction(action: RuntimeAction, context: EvaluationContext = {}): ActionEvaluation {
  const cwd = pathOrCurrent(context.cwd);
  const dbPath = context.dbPath ?? defaultDbPath(cwd);
  const parsedAction = action.parsed;
  const targets = resolveTargets(parsedAction, cwd);
  const risk = analyzeRisk(parsedAction, targets);
  const dbContext = openDatabase(dbPath);
  const legacyPolicy = evaluatePolicies(parsedAction, risk, loadPolicies(dbContext.dbPath));
  const phaseOnePolicy = runtimeFilePolicy(mergePhaseOnePolicies(loadPhaseOnePolicies(cwd)));
  const filePolicy = evaluatePhaseOnePolicy(parsedAction, targets, risk, phaseOnePolicy);
  const memory = new MemoryEngine(dbContext.db);
  const memoryMatches = context.applyMemory === false ? [] : memory.findMatches(parsedAction, targets);
  const policyDecision = strongestDecision([legacyPolicy.decision, filePolicy.decision]);
  const decision = action.kind === "unknown" && policyDecision === "allow"
    ? (context.preferAskForWarnings ? "ask" : "warn")
    : context.preferAskForWarnings && policyDecision === "warn"
      ? "ask"
      : policyDecision;
  const policyReason = policyDecision === filePolicy.decision ? filePolicy.reason : legacyPolicy.reason;
  const reason = buildReason(action, parsedAction, targets, risk, policyReason, memoryMatches, decision);
  const safeAlternative = buildSafeAlternative(action, parsedAction, targets, decision, risk);
  const matchedPolicies = [
    ...(legacyPolicy.matchedRule ? [legacyPolicy.matchedRule] : []),
    ...filePolicy.matchedRules.map((rule) => `${rule.source}:${rule.name}`),
  ];

  return {
    action,
    parsedAction,
    targets,
    risk,
    policy: {
      decision: policyDecision,
      reason: policyReason,
      matchedPolicy: matchedPolicies[0],
      matchedPolicies,
    },
    memoryMatches,
    decision,
    reason,
    safeAlternative,
    matchedPolicies,
  };
}

function runtimeFilePolicy(policy: EffectivePhaseOnePolicy): EffectivePhaseOnePolicy {
  return {
    ...policy,
    rules: policy.rules.filter((rule) => rule.source !== "built-in"),
  };
}

function buildReason(
  action: RuntimeAction,
  parsedAction: ParsedAction,
  targets: ResolvedTargets,
  risk: RiskResult,
  policyReason: string,
  memoryMatches: MemoryMatch[],
  decision: Decision,
): string {
  const targetSummary = targets.targetCount > 0 ? targets.expandedTargets.slice(0, 3).join(", ") : "no resolved targets";
  const danger = risk.signals.length > 0 ? risk.signals.join(", ") : "no specific danger signals";
  const memorySummary = summarizeMemoryMatches(memoryMatches);
  const decisionSuffix = decision === "ask" ? " Approval required." : "";
  return `${policyReason || risk.reason}. Semantic danger: ${parsedAction.semanticId}. Action kind: ${action.kind}. Targets: ${targetSummary}. Blast radius: ${risk.score}. Signals: ${danger}. Memory: ${memorySummary}.${decisionSuffix}`;
}

function buildSafeAlternative(
  action: RuntimeAction,
  parsedAction: ParsedAction,
  targets: ResolvedTargets,
  decision: Decision,
  risk: RiskResult,
): string {
  if (action.kind === "mcp.tool_call") {
    return `Use a Termyte MCP wrapper for the same workflow, or narrow the tool call before retrying.`;
  }

  if (action.kind === "unknown") {
    return "Resolve the hook payload into a concrete command or tool call before retrying.";
  }

  if (action.kind === "network.request") {
    return `Fetch the resource through a pinned, reviewed source or mirror it locally before running it.`;
  }

  switch (parsedAction.semanticId) {
    case "secret.access":
      return "Use the approved secret manager or request access through the normal workflow.";
    case "git.push.force":
      return "Use a normal git push, or push to a feature branch and open a review.";
    case "package.npm.publish":
    case "package.pnpm.publish":
    case "package.yarn.publish":
      return "Run the package command with a dry-run or pack step first.";
    case "sql.drop-table":
    case "sql.truncate-table":
    case "sql.delete-without-where":
      return "Use a narrower SQL statement or run it in a disposable database first.";
  }

  if (action.kind === "file.write" || action.kind === "file.edit") {
    if (targets.sensitiveTargets.length > 0 || targets.protectedTargets.length > 0) {
      return "Edit a narrower file, or stage the change in a temporary workspace before applying it.";
    }
    return "Preview the edit with `termyte check --json` before applying it.";
  }

  if (action.kind === "git.destructive") {
    return "Use a non-destructive git command or create a fresh branch before changing history.";
  }

  if (action.kind === "shell.command" && decision !== "allow") {
    return `Run \`termyte check --json ${JSON.stringify(action.command)}\` first.`;
  }

  if (risk.score >= 60) {
    return "Break the action into a smaller, reviewed step and re-run the evaluation.";
  }

  return `Run \`termyte check --json ${JSON.stringify(action.command)}\` first.`;
}

function summarizeMemoryMatches(memoryMatches: MemoryMatch[]): string {
  if (memoryMatches.length === 0) {
    return "no memory matches";
  }

  return memoryMatches
    .map((match) => `${match.semanticId} (${match.lastOutcome}, confidence ${match.confidence.toFixed(2)})`)
    .join("; ");
}

function pathOrCurrent(cwd?: string): string {
  return cwd ? cwd : process.cwd();
}

export function evaluationDecisionForHook(decision: Decision): "allow" | "deny" | "ask" {
  if (decision === "block") return "deny";
  if (decision === "warn" || decision === "ask") return "ask";
  return "allow";
}

export function shouldBlockMcpTool(toolName: string): boolean {
  return /(?:delete|destroy|drop|prune|purge|remove_repo|delete_repo|force|rm|erase)/i.test(toolName);
}
