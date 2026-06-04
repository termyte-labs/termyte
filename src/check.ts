import { loadPhaseOnePolicies } from "./policy-loader.js";
import { mergePhaseOnePolicies, type EffectivePhaseOnePolicy } from "./policy-merge.js";
import { evaluatePhaseOnePolicy, type MatchedPolicyRule } from "./policy-evaluator.js";
import { parseAction } from "./parser.js";
import { resolveTargets } from "./resolver.js";
import { analyzeRisk } from "./risk.js";
import { matchLocalMemory } from "./local-memory.js";
import { writeLocalLog } from "./local-logs.js";
import { normalizeCommandPattern } from "./local-state.js";
import type { Decision, LocalMemoryMatch, ParsedAction, ResolvedTargets, RiskResult } from "./types.js";

export interface PhaseOneCheckResult {
  command: string;
  normalized_command: string;
  decision: Decision;
  risk: "low" | "medium" | "high" | "critical";
  riskScore: number;
  reason: string;
  semantic_id: string;
  matched_rules: MatchedPolicyRule[];
  policy_sources: string[];
  memory_matches: LocalMemoryMatch[];
  executed: false;
  action: ParsedAction;
  targets: ResolvedTargets;
  riskResult: RiskResult;
}

export function checkCommand(command: string, cwd = process.cwd()): PhaseOneCheckResult {
  const result = inspectCommand(command, cwd, { applyMemory: true });
  writeCheckLog(result, cwd);
  return result;
}

export function inspectCommand(
  command: string,
  cwd = process.cwd(),
  options: { applyMemory?: boolean } = {},
): PhaseOneCheckResult {
  if (!command.trim()) {
    throw new Error("Missing command to check.");
  }

  const action = parseAction(command);
  const targets = resolveTargets(action, cwd);
  const riskResult = analyzeRisk(action, targets);
  const policy = mergePhaseOnePolicies(loadPhaseOnePolicies(cwd));
  return checkCommandWithPolicy(command, action, targets, riskResult, policy, cwd, options);
}

export function checkCommandWithPolicy(
  command: string,
  action: ParsedAction,
  targets: ResolvedTargets,
  riskResult: RiskResult,
  policy: EffectivePhaseOnePolicy,
  cwd = process.cwd(),
  options: { applyMemory?: boolean } = {},
): PhaseOneCheckResult {
  const policyResult = evaluatePhaseOnePolicy(action, targets, riskResult, policy);
  const memoryMatches = options.applyMemory === false ? [] : matchLocalMemory(action.redactedCommand, cwd);
  const memoryAdjustedDecision = applyMemoryDecision(policyResult.decision, memoryMatches);
  const reason = memoryAdjustedDecision !== policyResult.decision
    ? `This resembles a command you marked unsafe: ${memoryMatches.find((match) => match.type === "unsafe")?.pattern ?? action.redactedCommand}`
    : policyResult.reason;
  const policySources = uniqueSources(policyResult.matchedRules.map((rule) => rule.source));

  return {
    command: action.redactedCommand,
    normalized_command: normalizeCommandPattern(action.redactedCommand),
    decision: memoryAdjustedDecision,
    risk: riskBand(riskResult.score),
    riskScore: riskResult.score,
    reason,
    semantic_id: action.semanticId,
    matched_rules: policyResult.matchedRules,
    policy_sources: policySources,
    memory_matches: memoryMatches,
    executed: false,
    action,
    targets,
    riskResult,
  };
}

export function formatCheckHuman(result: PhaseOneCheckResult): string {
  const matched = result.matched_rules.length > 0
    ? result.matched_rules.map((rule) => `${rule.source}:${rule.name} (${rule.action})`).join("; ")
    : "none";
  const memory = result.memory_matches.length > 0
    ? result.memory_matches.map((match) => `${match.type}:${match.pattern}`).join("; ")
    : "none";
  return [
    `Decision: ${result.decision}`,
    `Risk: ${result.risk} (${result.riskScore})`,
    `Semantic ID: ${result.semantic_id}`,
    `Reason: ${result.reason}`,
    `Matched policy: ${matched}`,
    `Memory matches: ${memory}`,
    "Executed: false",
  ].join("\n");
}

function riskBand(score: number): PhaseOneCheckResult["risk"] {
  if (score >= 90) return "critical";
  if (score >= 60) return "high";
  if (score >= 30) return "medium";
  return "low";
}

function applyMemoryDecision(decision: Decision, matches: LocalMemoryMatch[]): Decision {
  if (decision === "block" || decision === "ask" || decision === "warn") {
    return decision;
  }
  return matches.some((match) => match.type === "unsafe") ? "warn" : decision;
}

function uniqueSources(values: string[]): string[] {
  return [...new Set(values)];
}

function writeCheckLog(result: PhaseOneCheckResult, cwd: string): void {
  writeLocalLog(
    {
      repo: result.targets.workspaceRoot.split(/[/\\]/).pop() ?? "unknown",
      agent: process.env.TERMYTE_AGENT,
      session_id: process.env.TERMYTE_SESSION_ID,
      command: result.command,
      normalized_command: result.normalized_command,
      decision: result.decision,
      action: result.decision,
      risk: result.risk,
      reason: result.reason,
      matched_rules: result.matched_rules,
      policy_sources: result.policy_sources,
      memory_matches: result.memory_matches,
    },
    cwd,
  );
}
