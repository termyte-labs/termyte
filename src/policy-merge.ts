import type { Decision } from "./types.js";
import type { LoadedPolicies, LoadedPolicyLayer } from "./policy-loader.js";
import type { PhaseOnePolicyRule, PolicyMode } from "./policy-schema.js";

export interface EffectivePhaseOnePolicy {
  layers: LoadedPolicyLayer[];
  mode: PolicyMode;
  presets: string[];
  rules: PhaseOnePolicyRule[];
  warnings: string[];
}

export function mergePhaseOnePolicies(loaded: LoadedPolicies): EffectivePhaseOnePolicy {
  const presets = unique(loaded.layers.flatMap((layer) => layer.presets));
  const rules = loaded.layers.flatMap((layer) => layer.rules.map((rule) => ({ ...rule, source: rule.source ?? layer.name })));
  const mode = [...loaded.layers].reverse().find((layer) => layer.loaded && layer.mode)?.mode ?? "standard";
  return {
    layers: loaded.layers,
    mode,
    presets,
    rules,
    warnings: loaded.warnings,
  };
}

export function compareDecisions(left: Decision, right: Decision): number {
  return decisionRank(left) - decisionRank(right);
}

export function strongestDecision(decisions: Decision[]): Decision {
  return decisions.reduce<Decision>((strongest, decision) => (compareDecisions(decision, strongest) > 0 ? decision : strongest), "allow");
}

function decisionRank(decision: Decision): number {
  if (decision === "allow") return 0;
  if (decision === "warn") return 1;
  if (decision === "ask") return 2;
  return 3;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
