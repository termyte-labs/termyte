import { formatCheckHuman, inspectCommand } from "./check.js";
import { globalPolicyPath, loadPhaseOnePolicies, localPolicyPath } from "./policy-loader.js";
import { mergePhaseOnePolicies } from "./policy-merge.js";
import {
  appendPolicyRule,
  compileNaturalLanguagePolicy,
  formatPolicyRulePreview,
  formatUnsupportedPolicyError,
  type CompileFailure,
} from "./policy-nl.js";
import { phaseOnePolicyPresets } from "./policy-presets.js";
import type { PhaseOnePolicyRule } from "./policy-schema.js";

export interface PolicyAddPlan {
  scope: "global" | "local";
  filePath: string;
  rule: PhaseOnePolicyRule;
  preview: string;
}

export type PolicyAddPlanResult =
  | { ok: true; plan: PolicyAddPlan }
  | { ok: false; output: string; failure: CompileFailure };

export function formatPolicyPresets(json = false): string {
  const payload = {
    presets: phaseOnePolicyPresets.map((preset) => ({
      name: preset.name,
      description: preset.description,
      rules: preset.rules.length,
    })),
  };
  if (json) {
    return JSON.stringify(payload, null, 2);
  }
  return payload.presets.map((preset) => `${preset.name}: ${preset.description} (${preset.rules} rules)`).join("\n");
}

export function formatPolicyShow(cwd = process.cwd(), json = false): string {
  const effective = mergePhaseOnePolicies(loadPhaseOnePolicies(cwd));
  const payload = {
    mode: effective.mode,
    layers: effective.layers.map((layer) => ({
      name: layer.name,
      path: layer.path,
      loaded: layer.loaded,
      mode: layer.mode,
    })),
    presets: effective.presets,
    rules: effective.rules.map((rule) => ({
      name: rule.name,
      description: rule.description,
      action: rule.action,
      source: rule.source,
      preset: rule.preset,
      match: rule.match,
    })),
    warnings: effective.warnings,
  };

  if (json) {
    return JSON.stringify(payload, null, 2);
  }

  return [
    "Termyte effective policy",
    `Mode: ${payload.mode}`,
    "Layers:",
    ...payload.layers.map((layer) => `  ${layer.name}: ${layer.loaded ? "loaded" : "missing"}${layer.path ? ` (${layer.path})` : ""}`),
    `Presets: ${payload.presets.length > 0 ? payload.presets.join(", ") : "none"}`,
    "Rules:",
    ...payload.rules.map((rule) => `  ${rule.action} ${rule.name} [${rule.source}${rule.preset ? `/${rule.preset}` : ""}]`),
    ...(payload.warnings.length > 0 ? [
      "Warnings:",
      ...payload.warnings.map((warning) => `  ${warning}`),
    ] : []),
  ].join("\n");
}

export function runPolicyTest(command: string, cwd = process.cwd(), json = false): { output: string; exitCode: number } {
  const result = inspectCommand(command, cwd, { applyMemory: false });
  return {
    output: json ? JSON.stringify(slimCheckResult(result), null, 2) : formatCheckHuman(result),
    exitCode: result.decision === "block" ? 1 : 0,
  };
}

export function buildPolicyAddPlan(scope: "global" | "local", naturalLanguageRule: string, cwd = process.cwd()): PolicyAddPlanResult {
  const compiled = compileNaturalLanguagePolicy(naturalLanguageRule);
  if (!compiled.ok) {
    return {
      ok: false,
      output: formatUnsupportedPolicyError(compiled.failure),
      failure: compiled.failure,
    };
  }

  const filePath = scope === "global" ? globalPolicyPath() : localPolicyPath(cwd);
  return {
    ok: true,
    plan: {
      scope,
      filePath,
      rule: compiled.compiled.rule,
      preview: formatPolicyRulePreview(scope, compiled.compiled.rule),
    },
  };
}

export function savePolicyAddPlan(plan: PolicyAddPlan): string {
  const document = appendPolicyRule(plan.filePath, plan.rule);
  const savedRule = document.rules[document.rules.length - 1];
  return [
    `Saved ${plan.scope} policy rule:`,
    `  ${savedRule?.name ?? plan.rule.name}`,
    "",
    "Policy file:",
    `  ${plan.filePath}`,
  ].join("\n");
}

export function slimCheckResult(result: ReturnType<typeof inspectCommand>): object {
  return {
    command: result.command,
    normalized_command: result.normalized_command,
    decision: result.decision,
    risk: result.risk,
    riskScore: result.riskScore,
    rule_id: result.rule_id,
    reason: result.reason,
    suggested_fix: result.suggested_fix,
    semantic_id: result.semantic_id,
    matched_rules: result.matched_rules,
    policy_sources: result.policy_sources,
    memory_matches: result.memory_matches,
    executed: false,
  };
}
