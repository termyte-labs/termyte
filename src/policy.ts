import { openDatabase } from "./db.js";
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

interface StoredPolicyRow {
  block_json: string;
  warn_json: string;
}

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

export function loadPolicies(dbPath: string): PolicySet {
  const { db } = openDatabase(dbPath);
  const row = db.prepare("SELECT block_json, warn_json FROM policy_state WHERE id = 1").get() as StoredPolicyRow | undefined;
  if (!row) {
    const defaults = clonePolicySet(defaultPolicies);
    savePolicies(dbPath, defaults);
    return defaults;
  }

  const block = parsePolicyList(row.block_json);
  const warn = parsePolicyList(row.warn_json);

  return {
    block,
    warn,
  };
}

export function savePolicies(dbPath: string, policies: PolicySet): PolicySet {
  const normalized = normalizePolicySet(policies);
  const { db } = openDatabase(dbPath);
  db.prepare(
    `
    INSERT INTO policy_state (id, block_json, warn_json, updated_at)
    VALUES (1, @block_json, @warn_json, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      block_json = excluded.block_json,
      warn_json = excluded.warn_json,
      updated_at = excluded.updated_at
    `,
  ).run({
    block_json: JSON.stringify(normalized.block),
    warn_json: JSON.stringify(normalized.warn),
    updated_at: new Date().toISOString(),
  });
  return normalized;
}

export function resetPolicies(dbPath: string): PolicySet {
  return savePolicies(dbPath, defaultPolicies);
}

export function addPolicies(dbPath: string, kind: keyof PolicySet, patterns: string[]): PolicySet {
  const current = loadPolicies(dbPath);
  const next = {
    block: [...current.block],
    warn: [...current.warn],
  };
  next[kind] = mergeUnique(next[kind], patterns);
  return savePolicies(dbPath, next);
}

export function removePolicies(dbPath: string, kind: keyof PolicySet, patterns: string[]): PolicySet {
  const current = loadPolicies(dbPath);
  const toRemove = new Set(normalizePatterns(patterns));
  const next = {
    block: [...current.block],
    warn: [...current.warn],
  };
  next[kind] = next[kind].filter((pattern) => !toRemove.has(pattern));
  return savePolicies(dbPath, next);
}

export function describePolicies(policies: PolicySet): string {
  return JSON.stringify(policies, null, 2);
}

function normalizePolicySet(policies: PolicySet): PolicySet {
  return {
    block: normalizePatterns(policies.block),
    warn: normalizePatterns(policies.warn),
  };
}

function normalizePatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function parsePolicyList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizePatterns(parsed.filter((value): value is string => typeof value === "string")) : [];
  } catch {
    return [];
  }
}

function clonePolicySet(policies: PolicySet): PolicySet {
  return {
    block: [...policies.block],
    warn: [...policies.warn],
  };
}

function mergeUnique(existing: string[], additions: string[]): string[] {
  return normalizePatterns([...existing, ...additions]);
}
