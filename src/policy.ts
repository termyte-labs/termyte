import type { Decision, ParsedAction, RiskResult } from "./types.js";

export interface PolicySet {
  block: string[];
  warn: string[];
}

export const defaultPolicies: PolicySet = {
  block: [
    "filesystem.delete.recursive.force.wildcard",
    "filesystem.delete.wildcard",
    "sql.drop-table",
    "sql.truncate-table",
    "sql.delete-without-where",
  ],
  warn: ["filesystem.delete.recursive.force", "git.push.force", "package.*.publish", "sql.delete-with-where"],
};

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern === value) return true;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function evaluatePolicies(action: ParsedAction, risk: RiskResult, policies: PolicySet = defaultPolicies): {
  decision: Decision;
  reason: string;
  matchedRule?: string;
} {
  const blockRule = policies.block.find((pattern) => matchesPattern(action.semanticId, pattern));
  if (blockRule) {
    return { decision: "block", reason: `policy block matched ${blockRule}`, matchedRule: blockRule };
  }

  const warnRule = policies.warn.find((pattern) => matchesPattern(action.semanticId, pattern));
  if (warnRule) {
    return { decision: risk.decision === "block" ? "block" : "warn", reason: `policy warn matched ${warnRule}`, matchedRule: warnRule };
  }

  return { decision: risk.decision, reason: risk.reason };
}
