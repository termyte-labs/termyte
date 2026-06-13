import type { Decision } from "./types.js";

export type PolicyLayerName = "built-in" | "global" | "local";
export type PolicyMode = "off" | "observe" | "standard" | "strict" | "paranoid";

export interface PolicyMatcher {
  semantic_ids?: string[];
  commands?: string[];
  paths?: string[];
}

export interface PhaseOnePolicyRule {
  name: string;
  description?: string;
  action: Decision;
  match: PolicyMatcher;
  source?: PolicyLayerName;
  preset?: string;
}

export interface PhaseOnePolicyDocument {
  version: 1;
  mode: PolicyMode;
  presets: string[];
  rules: PhaseOnePolicyRule[];
}

export interface PolicyValidationResult {
  valid: boolean;
  errors: string[];
}

const TOP_LEVEL_KEYS = new Set(["version", "mode", "presets", "rules"]);
const RULE_KEYS = new Set(["name", "description", "action", "match"]);
const MATCH_KEYS = new Set(["semantic_ids", "commands", "paths"]);
const ACTIONS = new Set(["allow", "warn", "ask", "block"]);
const POLICY_MODES = new Set(["off", "observe", "standard", "strict", "paranoid"]);

export function parsePhaseOnePolicyYaml(raw: string): unknown {
  const document: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  let section: "presets" | "rules" | null = null;
  let currentRule: Record<string, unknown> | null = null;
  let inMatch = false;
  let currentMatcher: string | null = null;

  for (const originalLine of lines) {
    const withoutComment = stripYamlComment(originalLine);
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();

    if (indent === 0) {
      section = null;
      inMatch = false;
      currentMatcher = null;
      const [key, value] = splitYamlPair(line);
      if (!key || !TOP_LEVEL_KEYS.has(key)) {
        throw new Error(`Unknown policy field: ${key || line}`);
      }
      if (key === "version") {
        document.version = parseScalar(value);
      } else if (key === "mode") {
        document.mode = parseScalar(value);
      } else if (key === "presets") {
        section = "presets";
        document.presets = parseInlineArray(value);
      } else if (key === "rules") {
        section = "rules";
        document.rules = [];
      }
      continue;
    }

    if (section === "presets") {
      if (!line.startsWith("- ")) {
        throw new Error(`Invalid presets entry: ${line}`);
      }
      const presets = ensureStringArray(document, "presets");
      presets.push(String(parseScalar(line.slice(2))));
      continue;
    }

    if (section === "rules") {
      const rules = ensureObjectArray(document, "rules");
      if (inMatch && line.startsWith("- ") && indent > 4) {
        if (!currentMatcher) {
          throw new Error(`Matcher value appears before matcher name: ${line}`);
        }
        const match = ensureRecord(currentRule ?? {}, "match");
        const values = ensureStringArray(match, currentMatcher);
        values.push(String(parseScalar(line.slice(2))));
        continue;
      }

      if (line.startsWith("- ")) {
        currentRule = {};
        rules.push(currentRule);
        inMatch = false;
        currentMatcher = null;
        const rest = line.slice(2).trim();
        if (rest) {
          const [key, value] = splitYamlPair(rest);
          setRuleField(currentRule, key, value);
        }
        continue;
      }

      if (!currentRule) {
        throw new Error(`Rule field appears before a rule: ${line}`);
      }

      if (line === "match:") {
        currentRule.match = {};
        inMatch = true;
        currentMatcher = null;
        continue;
      }

      if (inMatch && indent <= 4) {
        inMatch = false;
        currentMatcher = null;
      }

      if (inMatch) {
        const match = ensureRecord(currentRule, "match");
        const [key, value] = splitYamlPair(line);
        if (!MATCH_KEYS.has(key)) {
          throw new Error(`Unknown matcher field: ${key}`);
        }
        currentMatcher = key;
        match[key] = parseInlineArray(value);
        continue;
      }

      const [key, value] = splitYamlPair(line);
      setRuleField(currentRule, key, value);
      continue;
    }

    throw new Error(`Unexpected policy line: ${line}`);
  }

  return document;
}

export function normalizePhaseOnePolicyDocument(rawDocument: unknown, knownPresets: Set<string>): PhaseOnePolicyDocument {
  if (!isRecord(rawDocument)) {
    throw new Error("Policy file must be a YAML object.");
  }

  const errors = validateRawPolicyDocument(rawDocument, knownPresets);
  if (errors.length > 0) {
    throw new Error(`Invalid policy file: ${errors.join("; ")}`);
  }

  return {
    version: 1,
    mode: typeof rawDocument.mode === "string" ? rawDocument.mode as PolicyMode : "standard",
    presets: Array.isArray(rawDocument.presets) ? rawDocument.presets.map(String) : [],
    rules: Array.isArray(rawDocument.rules) ? rawDocument.rules.map((rule) => normalizeRule(rule as Record<string, unknown>)) : [],
  };
}

export function validateRawPolicyDocument(rawDocument: unknown, knownPresets: Set<string>): string[] {
  const errors: string[] = [];
  if (!isRecord(rawDocument)) {
    return ["policy file must be a YAML object"];
  }

  for (const key of Object.keys(rawDocument)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(`unknown top-level field "${key}"`);
  }

  if (rawDocument.version !== 1) {
    errors.push("version must be 1");
  }

  if (rawDocument.mode !== undefined && (typeof rawDocument.mode !== "string" || !POLICY_MODES.has(rawDocument.mode))) {
    errors.push("mode must be one of off, observe, standard, strict, paranoid");
  }

  if (rawDocument.presets !== undefined) {
    if (!Array.isArray(rawDocument.presets)) {
      errors.push("presets must be an array");
    } else {
      for (const preset of rawDocument.presets) {
        if (typeof preset !== "string" || !preset.trim()) {
          errors.push("preset names must be non-empty strings");
        } else if (!knownPresets.has(preset.trim())) {
          errors.push(`unknown preset "${preset}"`);
        }
      }
    }
  }

  if (rawDocument.rules !== undefined) {
    if (!Array.isArray(rawDocument.rules)) {
      errors.push("rules must be an array");
    } else {
      rawDocument.rules.forEach((rule, index) => validateRule(rule, index, errors));
    }
  }

  return errors;
}

function validateRule(rule: unknown, index: number, errors: string[]): void {
  if (!isRecord(rule)) {
    errors.push(`rules[${index}] must be an object`);
    return;
  }

  for (const key of Object.keys(rule)) {
    if (!RULE_KEYS.has(key)) errors.push(`rules[${index}] has unknown field "${key}"`);
  }

  if (typeof rule.name !== "string" || !rule.name.trim()) {
    errors.push(`rules[${index}].name must be a non-empty string`);
  }

  if (rule.description !== undefined && typeof rule.description !== "string") {
    errors.push(`rules[${index}].description must be a string`);
  }

  if (typeof rule.action !== "string" || !ACTIONS.has(rule.action)) {
    errors.push(`rules[${index}].action must be one of allow, warn, ask, block`);
  }

  if (!isRecord(rule.match)) {
    errors.push(`rules[${index}].match must be an object`);
    return;
  }

  const matcherKeys = Object.keys(rule.match);
  if (matcherKeys.length === 0) {
    errors.push(`rules[${index}].match must include at least one matcher`);
  }

  for (const key of matcherKeys) {
    if (!MATCH_KEYS.has(key)) {
      errors.push(`rules[${index}].match has unknown field "${key}"`);
      continue;
    }
    const values = rule.match[key];
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== "string" || !value.trim())) {
      errors.push(`rules[${index}].match.${key} must be a non-empty string array`);
    }
  }
}

function normalizeRule(rule: Record<string, unknown>): PhaseOnePolicyRule {
  return {
    name: String(rule.name).trim(),
    description: typeof rule.description === "string" ? rule.description.trim() : undefined,
    action: rule.action as Decision,
    match: normalizeMatcher(rule.match as Record<string, unknown>),
  };
}

function normalizeMatcher(match: Record<string, unknown>): PolicyMatcher {
  const result: PolicyMatcher = {};
  for (const key of MATCH_KEYS) {
    const values = match[key];
    if (Array.isArray(values)) {
      result[key as keyof PolicyMatcher] = values.map((value) => String(value).trim());
    }
  }
  return result;
}

function setRuleField(rule: Record<string, unknown>, key: string, value: string): void {
  if (!RULE_KEYS.has(key) || key === "match") {
    throw new Error(`Unknown rule field: ${key}`);
  }
  rule[key] = parseScalar(value);
}

function stripYamlComment(line: string): string {
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "#") {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function splitYamlPair(line: string): [string, string] {
  const index = line.indexOf(":");
  if (index === -1) {
    throw new Error(`Expected key: value pair: ${line}`);
  }
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function parseScalar(value: string): string | number {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    throw new Error(`Expected YAML array, found: ${value}`);
  }
  const inner = trimmed.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(",").map((entry) => String(parseScalar(entry.trim())));
}

function ensureStringArray(container: Record<string, unknown>, key: string): string[] {
  if (!Array.isArray(container[key])) {
    container[key] = [];
  }
  return container[key] as string[];
}

function ensureObjectArray(container: Record<string, unknown>, key: string): Record<string, unknown>[] {
  if (!Array.isArray(container[key])) {
    container[key] = [];
  }
  return container[key] as Record<string, unknown>[];
}

function ensureRecord(container: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(container[key])) {
    container[key] = {};
  }
  return container[key] as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
