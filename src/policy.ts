import { openDatabase } from "./db.js";
import type { Decision, ParsedAction, RiskResult } from "./types.js";

export interface PolicySet {
  block: string[];
  warn: string[];
}

export interface PolicyMetadata {
  defaultVersion: number;
  customized: boolean;
  updatedAt?: string;
}

export interface PolicyState {
  policies: PolicySet;
  metadata: PolicyMetadata;
}

export interface PolicyDocument {
  version: 1;
  exportedAt: string;
  defaultPolicyVersion: number;
  policies: PolicySet;
}

export const DEFAULT_POLICY_VERSION = 4;

export const defaultPolicies: PolicySet = {
  block: [
    "filesystem.delete.recursive.force.wildcard",
    "filesystem.delete.wildcard",
    "package.*.publish",
    "sql.drop-table",
    "sql.truncate-table",
    "sql.delete-without-where",
  ],
  warn: [
    "filesystem.delete.recursive.force",
    "git.push.force",
    "git.reset.*",
    "git.clean.*",
    "git.checkout.force",
    "git.branch.delete.force",
    "git.tag.delete",
    "git.stash.drop",
    "git.rebase.interactive",
    "git.reflog.expire",
    "package.*.install",
    "secret.access",
    "remote-script.*",
    "privilege.escalation",
    "docker.*",
    "deploy.*",
    "sql.delete-with-where",
  ],
};

interface StoredPolicyRow {
  block_json: string;
  warn_json: string;
  default_version?: number;
  customized?: number;
  updated_at?: string;
}

const POLICY_PATTERN_RE = /^[A-Za-z0-9*_.-]+$/;

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
  return loadPolicyState(dbPath).policies;
}

export function loadPolicyState(dbPath: string): PolicyState {
  const { db } = openDatabase(dbPath);
  const row = db.prepare("SELECT block_json, warn_json, default_version, customized, updated_at FROM policy_state WHERE id = 1").get() as StoredPolicyRow | undefined;
  if (!row) {
    const defaults = clonePolicySet(defaultPolicies);
    savePolicies(dbPath, defaults, { customized: false, defaultVersion: DEFAULT_POLICY_VERSION });
    return {
      policies: defaults,
      metadata: {
        defaultVersion: DEFAULT_POLICY_VERSION,
        customized: false,
      },
    };
  }

  const block = parsePolicyList(row.block_json);
  const warn = parsePolicyList(row.warn_json);

  return {
    policies: {
      block,
      warn,
    },
    metadata: {
      defaultVersion: typeof row.default_version === "number" ? row.default_version : 0,
      customized: row.customized === 1,
      updatedAt: row.updated_at,
    },
  };
}

export function savePolicies(dbPath: string, policies: PolicySet, metadata: Partial<PolicyMetadata> = { customized: true }): PolicySet {
  const normalized = normalizePolicySet(policies);
  const errors = validatePolicySet(normalized);
  if (errors.length > 0) {
    throw new Error(`Invalid policy set: ${errors.join("; ")}`);
  }
  const { db } = openDatabase(dbPath);
  const existing = db.prepare("SELECT default_version, customized FROM policy_state WHERE id = 1").get() as StoredPolicyRow | undefined;
  const defaultVersion = metadata.defaultVersion ?? existing?.default_version ?? 0;
  const customized = metadata.customized ?? (existing ? existing.customized === 1 : true);
  db.prepare(
    `
    INSERT INTO policy_state (id, block_json, warn_json, default_version, customized, updated_at)
    VALUES (1, @block_json, @warn_json, @default_version, @customized, @updated_at)
    ON CONFLICT(id) DO UPDATE SET
      block_json = excluded.block_json,
      warn_json = excluded.warn_json,
      default_version = excluded.default_version,
      customized = excluded.customized,
      updated_at = excluded.updated_at
    `,
  ).run({
    block_json: JSON.stringify(normalized.block),
    warn_json: JSON.stringify(normalized.warn),
    default_version: defaultVersion,
    customized: customized ? 1 : 0,
    updated_at: new Date().toISOString(),
  });
  return normalized;
}

export function resetPolicies(dbPath: string): PolicySet {
  return savePolicies(dbPath, defaultPolicies, { customized: false, defaultVersion: DEFAULT_POLICY_VERSION });
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

export function exportPolicyDocument(policies: PolicySet, exportedAt = new Date().toISOString()): PolicyDocument {
  return {
    version: 1,
    exportedAt,
    defaultPolicyVersion: DEFAULT_POLICY_VERSION,
    policies: normalizePolicySet(policies),
  };
}

export function analyzePolicyDrift(state: PolicyState, defaults: PolicySet = defaultPolicies): {
  staleDefaultVersion: boolean;
  customized: boolean;
  missingBlockDefaults: string[];
  missingWarnDefaults: string[];
  extraBlockRules: string[];
  extraWarnRules: string[];
} {
  const policies = normalizePolicySet(state.policies);
  const normalizedDefaults = normalizePolicySet(defaults);
  return {
    staleDefaultVersion: state.metadata.defaultVersion < DEFAULT_POLICY_VERSION,
    customized: state.metadata.customized,
    missingBlockDefaults: difference(normalizedDefaults.block, policies.block),
    missingWarnDefaults: difference(normalizedDefaults.warn, policies.warn),
    extraBlockRules: difference(policies.block, normalizedDefaults.block),
    extraWarnRules: difference(policies.warn, normalizedDefaults.warn),
  };
}

export function parsePolicyDocument(raw: string): PolicySet {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Policy file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("Policy file must be a JSON object.");
  }

  const candidate = isRecord(parsed.policies) ? parsed.policies : parsed;
  const block = Array.isArray(candidate.block) ? candidate.block : undefined;
  const warn = Array.isArray(candidate.warn) ? candidate.warn : undefined;

  if (!block || !warn) {
    throw new Error("Policy file must include block and warn arrays, either at the top level or under policies.");
  }

  const policies = normalizePolicySet({
    block: block.filter((value): value is string => typeof value === "string"),
    warn: warn.filter((value): value is string => typeof value === "string"),
  });
  const errors = validatePolicySet(policies);
  if (errors.length > 0) {
    throw new Error(`Invalid policy file: ${errors.join("; ")}`);
  }
  return policies;
}

export function validatePolicySet(policies: PolicySet): string[] {
  const errors: string[] = [];
  validatePatterns("block", policies.block, errors);
  validatePatterns("warn", policies.warn, errors);
  return errors;
}

function normalizePolicySet(policies: PolicySet): PolicySet {
  return {
    block: normalizePatterns(policies.block),
    warn: normalizePatterns(policies.warn),
  };
}

function validatePatterns(kind: keyof PolicySet, patterns: string[], errors: string[]): void {
  for (const pattern of patterns) {
    if (!POLICY_PATTERN_RE.test(pattern)) {
      errors.push(`${kind} pattern "${pattern}" must use only letters, numbers, dot, dash, underscore, and *`);
    }
    if (pattern === "*") {
      errors.push(`${kind} pattern "*" is too broad; use a narrower semantic pattern`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function difference(expected: string[], actual: string[]): string[] {
  const actualSet = new Set(actual);
  return expected.filter((pattern) => !actualSet.has(pattern));
}
