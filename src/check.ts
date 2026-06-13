import { loadPhaseOnePolicies } from "./policy-loader.js";
import { mergePhaseOnePolicies, type EffectivePhaseOnePolicy } from "./policy-merge.js";
import { evaluatePhaseOnePolicy, type MatchedPolicyRule } from "./policy-evaluator.js";
import { parseAction } from "./parser.js";
import { resolveTargets } from "./resolver.js";
import { analyzeRisk } from "./risk.js";
import { findMatchingApproval } from "./local-approvals.js";
import { matchLocalMemory } from "./local-memory.js";
import { normalizeCommandPattern } from "./local-state.js";
import type { Decision, LocalMemoryMatch, ParsedAction, ResolvedTargets, RiskResult } from "./types.js";

export interface PhaseOneCheckResult {
  command: string;
  normalized_command: string;
  decision: Decision;
  risk: "low" | "medium" | "high" | "critical";
  riskScore: number;
  rule_id?: string;
  reason: string;
  suggested_fix?: string;
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
  return inspectCommand(command, cwd, { applyMemory: true });
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
  const approval = findMatchingApproval(action.redactedCommand, cwd);
  const memoryAdjustedDecision = applyMemoryDecision(policyResult.decision, memoryMatches, approval);
  const unsafeMatch = memoryMatches.find((match) => match.type === "unsafe");
  const safeMatch = memoryMatches.find((match) => match.type === "safe");
  const reason = approval && policyResult.decision !== "block"
    ? `One-time approval applied for ${approval.command}.`
    : memoryAdjustedDecision !== policyResult.decision && unsafeMatch
      ? `This resembles a command you marked unsafe: ${unsafeMatch.pattern}`
      : memoryAdjustedDecision !== policyResult.decision && safeMatch
        ? `This command was marked safe in this repository: ${safeMatch.pattern}`
        : policyResult.reason;
  const policySources = uniqueSources(policyResult.matchedRules.map((rule) => rule.source));

  return {
    command: action.redactedCommand,
    normalized_command: normalizeCommandPattern(action.redactedCommand),
    decision: memoryAdjustedDecision,
    risk: riskBand(riskResult.score),
    riskScore: riskResult.score,
    rule_id: riskResult.ruleId,
    reason,
    suggested_fix: riskResult.suggestedFix,
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
    `Rule: ${result.rule_id ?? result.semantic_id}`,
    `Semantic ID: ${result.semantic_id}`,
    `Reason: ${result.reason}`,
    `Suggested fix: ${result.suggested_fix ?? "none"}`,
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

function applyMemoryDecision(decision: Decision, matches: LocalMemoryMatch[], approval?: { used_at: string | null } | null): Decision {
  if (approval && decision !== "block") {
    return "allow";
  }
  if (decision === "block" || decision === "ask") {
    return decision;
  }
  if (decision === "warn") {
    return matches.some((match) => match.type === "safe") ? "allow" : "warn";
  }
  return matches.some((match) => match.type === "unsafe") ? "warn" : decision;
}

function uniqueSources(values: string[]): string[] {
  return [...new Set(values)];
}
