import fs from "node:fs";
import path from "node:path";
import { loadPolicyFile } from "./policy-loader.js";
import { normalizePhaseOnePolicyDocument, type PhaseOnePolicyDocument, type PhaseOnePolicyRule } from "./policy-schema.js";
import { presetNames } from "./policy-presets.js";
import type { Decision } from "./types.js";

export interface CompiledNaturalLanguagePolicy {
  rule: PhaseOnePolicyRule;
  pattern: string;
}

export interface CompileFailure {
  error: string;
  examples: string[];
}

export type CompileNaturalLanguagePolicyResult =
  | { ok: true; compiled: CompiledNaturalLanguagePolicy }
  | { ok: false; failure: CompileFailure };

const SUPPORTED_EXAMPLES = [
  'Never allow agents to read .env files',
  'Ask before touching auth or payments',
  'Warn before npm publish',
  'Block destructive database commands',
];

interface PatternDefinition {
  id: string;
  defaultAction: Decision;
  baseName: (action: Decision) => string;
  matches: (normalized: string) => boolean;
  match: PhaseOnePolicyRule["match"];
}

const PATTERNS: PatternDefinition[] = [
  {
    id: "secret-access",
    defaultAction: "block",
    baseName: () => "block-env-file-access",
    matches: (text) => (/\b(env|secret|secrets)\b/.test(text) || text.includes(".env")) && /\b(read|access|file|files)\b/.test(text),
    match: {
      semantic_ids: ["secret.access"],
      paths: [".env", ".env.*"],
    },
  },
  {
    id: "force-push",
    defaultAction: "block",
    baseName: () => "block-git-force-push",
    matches: (text) => text.includes("force push")
      || text.includes("force pushing")
      || text.includes("git push --force")
      || text.includes("git push -f")
      || text.includes("git push force")
      || /\bgit push f\b/.test(text),
    match: {
      semantic_ids: ["git.push.force"],
      commands: ["git push --force", "git push -f"],
    },
  },
  {
    id: "auth-payment-paths",
    defaultAction: "ask",
    baseName: (action) => `${action}-auth-payment-changes`,
    matches: (text) => /\b(auth|payment|payments|billing)\b/.test(text),
    match: {
      paths: ["src/auth/**", "src/payments/**", "src/billing/**"],
    },
  },
  {
    id: "test-deletion",
    defaultAction: "block",
    baseName: () => "block-test-deletion",
    matches: (text) => /\b(delete|deleting|remove|removing)\b/.test(text) && /\b(test|tests)\b/.test(text),
    match: {
      semantic_ids: ["filesystem.delete*"],
      paths: ["tests/**", "**tests**/**", "**/*.test.*", "**/*.spec.*"],
    },
  },
  {
    id: "package-publishing",
    defaultAction: "warn",
    baseName: (action) => `${action}-package-publishing`,
    matches: (text) => /\b(package publishing|publish|publishing|npm publish|pnpm publish|yarn publish)\b/.test(text),
    match: {
      semantic_ids: ["package.*.publish"],
      commands: ["npm publish", "pnpm publish", "yarn publish"],
    },
  },
  {
    id: "infra-deployment",
    defaultAction: "warn",
    baseName: (action) => `${action}-infra-deployment-changes`,
    matches: (text) => /\b(deployment|deploy|infra|workflow|workflows|docker|terraform|k8s|kubernetes|vercel|railway)\b/.test(text),
    match: {
      paths: [".github/workflows/**", "Dockerfile", "docker-compose.yml", "terraform/**", "k8s/**", "vercel.json", "railway.json"],
    },
  },
  {
    id: "database-destructive",
    defaultAction: "block",
    baseName: () => "block-destructive-database-commands",
    matches: (text) => /\b(database|sql|drop table|drop database|truncate table|delete from)\b/.test(text) && /\b(destructive|drop|truncate|delete|database|sql)\b/.test(text),
    match: {
      semantic_ids: ["sql.destructive", "sql.drop-table", "sql.truncate-table", "sql.delete-without-where"],
      commands: ["DROP TABLE", "DROP DATABASE", "TRUNCATE TABLE", "DELETE FROM"],
    },
  },
];

export function compileNaturalLanguagePolicy(input: string): CompileNaturalLanguagePolicyResult {
  const original = input.trim();
  if (!original) {
    return failure("Policy rule text is required.");
  }

  const normalized = normalizeNaturalLanguage(original);
  const action = inferAction(normalized);
  if (action.error) {
    return failure(action.error);
  }

  const matches = PATTERNS.filter((pattern) => pattern.matches(normalized));
  if (matches.length === 0) {
    return failure("Unsupported policy rule. Use one of the supported v0 policy patterns.");
  }
  if (matches.length > 1) {
    return failure(`Ambiguous policy rule. It matched multiple patterns: ${matches.map((match) => match.id).join(", ")}.`);
  }

  const pattern = matches[0];
  const finalAction = action.action ?? pattern.defaultAction;
  const rule: PhaseOnePolicyRule = {
    name: slugify(pattern.baseName(finalAction)),
    description: original,
    action: finalAction,
    match: cloneMatch(pattern.match),
  };

  return {
    ok: true,
    compiled: {
      rule,
      pattern: pattern.id,
    },
  };
}

export function appendPolicyRule(filePath: string, rule: PhaseOnePolicyRule): PhaseOnePolicyDocument {
  const document = fs.existsSync(filePath)
    ? loadPolicyFile(filePath)
    : { version: 1 as const, presets: [], rules: [] };
  const nextRule = {
    ...stripRuntimeRuleMetadata(rule),
    name: uniqueRuleName(rule.name, document.rules.map((entry) => entry.name)),
  };
  const nextDocument = normalizePhaseOnePolicyDocument({
    version: 1,
    presets: document.presets,
    rules: [...document.rules.map(stripRuntimeRuleMetadata), nextRule],
  }, presetNames());

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${formatPolicyDocumentYaml(nextDocument)}\n`, "utf8");
  return nextDocument;
}

export function formatGeneratedPolicyRuleYaml(rule: PhaseOnePolicyRule): string {
  return formatPolicyDocumentYaml({
    version: 1,
    presets: [],
    rules: [stripRuntimeRuleMetadata(rule)],
  });
}

export function formatPolicyDocumentYaml(document: PhaseOnePolicyDocument): string {
  const lines = ["version: 1"];
  if (document.presets.length === 0) {
    lines.push("presets: []");
  } else {
    lines.push("presets:");
    for (const preset of document.presets) {
      lines.push(`  - ${quoteYaml(preset)}`);
    }
  }

  if (document.rules.length === 0) {
    lines.push("rules: []");
  } else {
    lines.push("rules:");
    for (const rule of document.rules) {
      lines.push(`  - name: ${quoteYaml(rule.name)}`);
      if (rule.description) {
        lines.push(`    description: ${quoteYaml(rule.description)}`);
      }
      lines.push(`    action: ${rule.action}`);
      lines.push("    match:");
      appendMatcher(lines, "semantic_ids", rule.match.semantic_ids);
      appendMatcher(lines, "commands", rule.match.commands);
      appendMatcher(lines, "paths", rule.match.paths);
    }
  }

  return lines.join("\n");
}

export function formatUnsupportedPolicyError(failureResult: CompileFailure): string {
  return [
    "Could not compile that policy rule.",
    "",
    failureResult.error,
    "",
    "Supported examples:",
    ...failureResult.examples.map((example) => `  termyte policy local add "${example}"`),
    "",
    "No policy file was changed.",
  ].join("\n");
}

export function formatPolicyRulePreview(scope: "global" | "local", rule: PhaseOnePolicyRule): string {
  const matcherLines = [
    ...(rule.match.semantic_ids ? ["  semantic_ids:", ...rule.match.semantic_ids.map((value) => `    - ${value}`)] : []),
    ...(rule.match.commands ? ["  commands:", ...rule.match.commands.map((value) => `    - ${value}`)] : []),
    ...(rule.match.paths ? ["  paths:", ...rule.match.paths.map((value) => `    - ${value}`)] : []),
  ];
  return [
    `Generated ${scope} policy rule`,
    "",
    "Name:",
    `  ${rule.name}`,
    "",
    "Action:",
    `  ${rule.action}`,
    "",
    "Matches:",
    ...matcherLines,
    "",
    "YAML:",
    formatGeneratedPolicyRuleYaml(rule),
  ].join("\n");
}

function inferAction(normalized: string): { action?: Decision; error?: string } {
  const actions: Decision[] = [];
  if (/\b(block|deny|prevent)\b/.test(normalized) || normalized.includes("never allow")) {
    actions.push("block");
  }
  if (/\b(ask|confirm|approval)\b/.test(normalized)) {
    actions.push("ask");
  }
  if (/\b(warn|warning)\b/.test(normalized)) {
    actions.push("warn");
  }

  const uniqueActions = [...new Set(actions)];
  if (uniqueActions.length > 1) {
    return { error: `Ambiguous action. Found conflicting actions: ${uniqueActions.join(", ")}.` };
  }
  return { action: uniqueActions[0] };
}

function failure(error: string): CompileNaturalLanguagePolicyResult {
  return {
    ok: false,
    failure: {
      error,
      examples: SUPPORTED_EXAMPLES,
    },
  };
}

function normalizeNaturalLanguage(input: string): string {
  return input.trim().toLowerCase().replace(/[._-]+/g, (value) => value.includes(".") ? value : " ").replace(/\s+/g, " ");
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/g, "");
}

function cloneMatch(match: PhaseOnePolicyRule["match"]): PhaseOnePolicyRule["match"] {
  const cloned: PhaseOnePolicyRule["match"] = {};
  if (match.semantic_ids) cloned.semantic_ids = [...match.semantic_ids];
  if (match.commands) cloned.commands = [...match.commands];
  if (match.paths) cloned.paths = [...match.paths];
  return cloned;
}

function uniqueRuleName(baseName: string, existingNames: string[]): string {
  const names = new Set(existingNames);
  if (!names.has(baseName)) return baseName;
  let suffix = 2;
  while (names.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

function stripRuntimeRuleMetadata(rule: PhaseOnePolicyRule): PhaseOnePolicyRule {
  return {
    name: rule.name,
    description: rule.description,
    action: rule.action,
    match: cloneMatch(rule.match),
  };
}

function appendMatcher(lines: string[], key: keyof PhaseOnePolicyRule["match"], values?: string[]): void {
  if (!values || values.length === 0) return;
  lines.push(`      ${key}:`);
  for (const value of values) {
    lines.push(`        - ${quoteYaml(value)}`);
  }
}

function quoteYaml(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}
