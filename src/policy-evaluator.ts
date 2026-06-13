import path from "node:path";
import { strongestDecision } from "./policy-merge.js";
import type { EffectivePhaseOnePolicy } from "./policy-merge.js";
import { applyPolicyMode } from "./policy-modes.js";
import type { PhaseOnePolicyRule, PolicyMatcher } from "./policy-schema.js";
import type { Decision, ParsedAction, ResolvedTargets, RiskResult } from "./types.js";

export interface MatchedPolicyRule {
  name: string;
  action: Decision;
  source: string;
  preset?: string;
}

export interface PhaseOnePolicyEvaluation {
  decision: Decision;
  reason: string;
  matchedRules: MatchedPolicyRule[];
}

export function evaluatePhaseOnePolicy(
  action: ParsedAction,
  targets: ResolvedTargets,
  risk: RiskResult,
  policy: EffectivePhaseOnePolicy,
): PhaseOnePolicyEvaluation {
  const matchedRules = policy.rules.filter((rule) => ruleMatches(rule.match, action, targets)).map((rule) => ({
    name: rule.name,
    action: rule.action,
    source: rule.source ?? "unknown",
    preset: rule.preset,
  }));

  const decision = strongestDecision([risk.decision, ...matchedRules.map((rule) => rule.action)]);
  const modeResult = applyPolicyMode(decision, risk, policy.mode);
  const strongestMatches = matchedRules.filter((rule) => rule.action === decision);
  const baseReason = strongestMatches[0]
    ? `policy ${decision} matched ${strongestMatches[0].name}`
    : risk.reason;
  const reason = modeResult.reasonSuffix ? `${baseReason}. ${modeResult.reasonSuffix}` : baseReason;

  return {
    decision: modeResult.decision,
    reason,
    matchedRules,
  };
}

function ruleMatches(match: PolicyMatcher, action: ParsedAction, targets: ResolvedTargets): boolean {
  if (match.semantic_ids && !match.semantic_ids.some((pattern) => matchesPattern(action.semanticId, pattern))) {
    return false;
  }

  if (match.commands && !match.commands.some((pattern) => matchesCommand(action.rawCommand, pattern))) {
    return false;
  }

  if (match.paths && !match.paths.some((pattern) => matchesAnyPath(targets.expandedTargets, pattern))) {
    return false;
  }

  return true;
}

function matchesCommand(command: string, pattern: string): boolean {
  return normalizeCommand(command) === normalizeCommand(pattern) || matchesPattern(normalizeCommand(command), normalizeCommand(pattern));
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function matchesAnyPath(targets: string[], pattern: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  return targets.some((target) => {
    const normalizedTarget = normalizePath(target);
    return normalizedTarget.endsWith(normalizedPattern) || matchesPattern(normalizedTarget, normalizedPattern);
  });
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function matchesPattern(value: string, pattern: string): boolean {
  if (value === pattern) return true;
  const normalizedValue = value.toLowerCase();
  const normalizedPattern = pattern.toLowerCase();
  if (normalizedValue === normalizedPattern) return true;
  const escaped = normalizedPattern
    .split("*")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(normalizedValue) || normalizedValue.endsWith(path.sep + normalizedPattern);
}
