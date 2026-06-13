import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPhaseOnePresetName, phaseOnePolicyPresets, presetNames } from "./policy-presets.js";
import { normalizePhaseOnePolicyDocument, parsePhaseOnePolicyYaml, type PhaseOnePolicyDocument, type PhaseOnePolicyRule, type PolicyLayerName, type PolicyMode } from "./policy-schema.js";

export interface LoadedPolicyLayer {
  name: PolicyLayerName;
  path: string | null;
  loaded: boolean;
  mode?: PolicyMode;
  presets: string[];
  rules: PhaseOnePolicyRule[];
}

export interface LoadedPolicies {
  layers: LoadedPolicyLayer[];
  warnings: string[];
}

interface PolicyFileLoadResult {
  document: PhaseOnePolicyDocument;
  warnings: string[];
}

export function globalPolicyPath(): string {
  const home = process.env.TERMYTE_HOME ? path.resolve(process.env.TERMYTE_HOME) : path.join(os.homedir(), ".termyte");
  return path.join(home, "policy.yaml");
}

export function localPolicyPath(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), "termyte.policy.yaml");
}

export function projectPolicyPath(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), "termyte.yaml");
}

export function localPolicyCandidatePaths(cwd = process.cwd()): string[] {
  return [localPolicyPath(cwd), projectPolicyPath(cwd)];
}

export function loadPhaseOnePolicies(cwd = process.cwd()): LoadedPolicies {
  const builtin = builtInLayer();
  const globalResult = loadOptionalPolicyLayer("global", globalPolicyPath());
  const localResult = loadOptionalLocalPolicyLayer(cwd);
  return {
    layers: [builtin, globalResult.layer, localResult.layer],
    warnings: [...globalResult.warnings, ...localResult.warnings],
  };
}

export function loadPolicyFile(filePath: string): PhaseOnePolicyDocument {
  const raw = fs.readFileSync(filePath, "utf8");
  return normalizePhaseOnePolicyDocument(parsePhaseOnePolicyYaml(raw), presetNames());
}

export function loadProjectPolicyFile(filePath: string): PolicyFileLoadResult {
  const raw = fs.readFileSync(filePath, "utf8");
  if (path.basename(filePath) !== "termyte.yaml") {
    return { document: loadPolicyFile(filePath), warnings: [] };
  }
  return parseTermyteProjectPolicyYaml(raw, filePath);
}

function builtInLayer(): LoadedPolicyLayer {
  const preset = phaseOnePolicyPresets.find((entry) => entry.name === defaultPhaseOnePresetName);
  return {
    name: "built-in",
    path: null,
    loaded: true,
    mode: "standard",
    presets: [defaultPhaseOnePresetName],
    rules: (preset?.rules ?? []).map((rule) => ({ ...rule, source: "built-in", preset: defaultPhaseOnePresetName })),
  };
}

function loadOptionalLocalPolicyLayer(cwd: string): { layer: LoadedPolicyLayer; warnings: string[] } {
  const candidates = localPolicyCandidatePaths(cwd);
  const filePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!filePath) {
    return {
      layer: {
        name: "local",
        path: candidates[0],
        loaded: false,
        mode: undefined,
        presets: [],
        rules: [],
      },
      warnings: [],
    };
  }
  return loadOptionalPolicyLayer("local", filePath);
}

function loadOptionalPolicyLayer(name: "global" | "local", filePath: string): { layer: LoadedPolicyLayer; warnings: string[] } {
  if (!fs.existsSync(filePath)) {
    return {
      layer: {
        name,
        path: filePath,
        loaded: false,
        mode: undefined,
        presets: [],
        rules: [],
      },
      warnings: [],
    };
  }

  const { document, warnings } = name === "local" ? loadProjectPolicyFile(filePath) : { document: loadPolicyFile(filePath), warnings: [] };
  const presetRules = document.presets.flatMap((presetName) => rulesForPreset(presetName, name));
  return {
    layer: {
      name,
      path: filePath,
      loaded: true,
      mode: document.mode,
      presets: document.presets,
      rules: [
        ...presetRules,
        ...document.rules.map((rule) => ({ ...rule, source: name })),
      ],
    },
    warnings,
  };
}

function rulesForPreset(presetName: string, source: PolicyLayerName): PhaseOnePolicyRule[] {
  const preset = phaseOnePolicyPresets.find((entry) => entry.name === presetName);
  return (preset?.rules ?? []).map((rule) => ({ ...rule, source, preset: presetName }));
}

function parseTermyteProjectPolicyYaml(raw: string, filePath: string): PolicyFileLoadResult {
  const parsed = parseSimpleProjectYaml(raw);
  const warnings: string[] = [];
  const allowedTopLevel = new Set(["version", "mode", "presets", "rules", "protectedBranches", "protectedPaths", "secrets", "commands", "allow", "approvals", "memory"]);
  for (const key of Object.keys(parsed)) {
    if (!allowedTopLevel.has(key)) {
      warnings.push(`${filePath}: ignored unsupported termyte.yaml field "${key}"`);
    }
  }
  if (parsed.protectedBranches !== undefined) {
    warnings.push(`${filePath}: protectedBranches is documented for compatibility but branch matching currently uses built-in protected branch rules`);
  }
  if (parsed.approvals !== undefined) {
    warnings.push(`${filePath}: approvals is documented for compatibility but approval policy is currently handled by local one-time approvals`);
  }
  if (parsed.memory !== undefined) {
    warnings.push(`${filePath}: memory is documented for compatibility but memory settings currently use Termyte's built-in local memory behavior`);
  }

  const document = normalizePhaseOnePolicyDocument({
    version: parsed.version,
    mode: parsed.mode,
    presets: parsed.presets,
    rules: [
      ...coerceExistingRules(parsed.rules),
      ...rulesFromProjectPolicy(parsed),
    ],
  }, presetNames());
  return { document, warnings };
}

function rulesFromProjectPolicy(parsed: Record<string, unknown>): PhaseOnePolicyRule[] {
  const rules: PhaseOnePolicyRule[] = [];
  const protectedPaths = readStringArray(parsed.protectedPaths);
  if (protectedPaths.length > 0) {
    rules.push({
      name: "warn protected project paths",
      description: "Generated from termyte.yaml protectedPaths.",
      action: "warn",
      match: { paths: protectedPaths },
    });
  }

  const secrets = asRecord(parsed.secrets);
  const secretPaths = readStringArray(secrets?.blockRead);
  if (secretPaths.length > 0) {
    rules.push({
      name: "block configured secret reads",
      description: "Generated from termyte.yaml secrets.blockRead.",
      action: "block",
      match: { semantic_ids: ["secret.access"], paths: secretPaths },
    });
  }

  const commands = asRecord(parsed.commands);
  const blockCommands = expandCommandPatterns(readStringArray(commands?.block));
  if (blockCommands.length > 0) {
    rules.push({
      name: "block configured commands",
      description: "Generated from termyte.yaml commands.block.",
      action: "block",
      match: { commands: blockCommands },
    });
  }

  const warnCommands = expandCommandPatterns(readStringArray(commands?.warn));
  if (warnCommands.length > 0) {
    rules.push({
      name: "warn configured commands",
      description: "Generated from termyte.yaml commands.warn.",
      action: "warn",
      match: { commands: warnCommands },
    });
  }

  const allow = asRecord(parsed.allow);
  const allowCommands = expandCommandPatterns(readStringArray(allow?.commands));
  if (allowCommands.length > 0) {
    rules.push({
      name: "allow configured commands",
      description: "Generated from termyte.yaml allow.commands.",
      action: "allow",
      match: { commands: allowCommands },
    });
  }

  return rules;
}

function coerceExistingRules(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseSimpleProjectYaml(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> | unknown[] }> = [{ indent: -1, value: root }];

  for (const originalLine of raw.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(originalLine);
    if (!withoutComment.trim()) continue;

    const indent = withoutComment.length - withoutComment.trimStart().length;
    const line = withoutComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].value;

    if (line.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`Invalid termyte.yaml list entry: ${line}`);
      }
      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const [key, value] = splitYamlPair(line);
    if (Array.isArray(parent)) {
      throw new Error(`Invalid termyte.yaml mapping inside scalar list: ${line}`);
    }
    if (value) {
      parent[key] = parseScalarOrInlineArray(value);
      continue;
    }

    const child = nextMeaningfulLineIsList(raw, originalLine) ? [] : {};
    parent[key] = child;
    stack.push({ indent, value: child });
  }

  return root;
}

function nextMeaningfulLineIsList(raw: string, currentLine: string): boolean {
  const lines = raw.split(/\r?\n/);
  const index = lines.indexOf(currentLine);
  for (const line of lines.slice(index + 1)) {
    const withoutComment = stripYamlComment(line);
    if (!withoutComment.trim()) continue;
    return withoutComment.trim().startsWith("- ");
  }
  return false;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function expandCommandPatterns(commands: string[]): string[] {
  const result = new Set<string>();
  for (const command of commands) {
    result.add(command);
    if (!command.includes("*")) {
      result.add(`${command} *`);
    }
  }
  return [...result];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
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
    if (char === "#") return line.slice(0, index).trimEnd();
  }
  return line.trimEnd();
}

function splitYamlPair(line: string): [string, string] {
  const index = line.indexOf(":");
  if (index === -1) throw new Error(`Expected key: value pair in termyte.yaml: ${line}`);
  return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
}

function parseScalarOrInlineArray(value: string): string | number | boolean | string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((entry) => String(parseScalar(entry.trim())));
  }
  return parseScalar(trimmed);
}

function parseScalar(value: string): string | number | boolean {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}
