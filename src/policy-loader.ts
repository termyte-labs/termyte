import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPhaseOnePresetName, phaseOnePolicyPresets, presetNames } from "./policy-presets.js";
import { normalizePhaseOnePolicyDocument, parsePhaseOnePolicyYaml, type PhaseOnePolicyDocument, type PhaseOnePolicyRule, type PolicyLayerName } from "./policy-schema.js";

export interface LoadedPolicyLayer {
  name: PolicyLayerName;
  path: string | null;
  loaded: boolean;
  presets: string[];
  rules: PhaseOnePolicyRule[];
}

export interface LoadedPolicies {
  layers: LoadedPolicyLayer[];
  warnings: string[];
}

export function globalPolicyPath(): string {
  const home = process.env.TERMYTE_HOME ? path.resolve(process.env.TERMYTE_HOME) : path.join(os.homedir(), ".termyte");
  return path.join(home, "policy.yaml");
}

export function localPolicyPath(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), "termyte.policy.yaml");
}

export function loadPhaseOnePolicies(cwd = process.cwd()): LoadedPolicies {
  const builtin = builtInLayer();
  const global = loadOptionalPolicyLayer("global", globalPolicyPath());
  const local = loadOptionalPolicyLayer("local", localPolicyPath(cwd));
  return {
    layers: [builtin, global, local],
    warnings: [],
  };
}

export function loadPolicyFile(filePath: string): PhaseOnePolicyDocument {
  const raw = fs.readFileSync(filePath, "utf8");
  return normalizePhaseOnePolicyDocument(parsePhaseOnePolicyYaml(raw), presetNames());
}

function builtInLayer(): LoadedPolicyLayer {
  const preset = phaseOnePolicyPresets.find((entry) => entry.name === defaultPhaseOnePresetName);
  return {
    name: "built-in",
    path: null,
    loaded: true,
    presets: [defaultPhaseOnePresetName],
    rules: (preset?.rules ?? []).map((rule) => ({ ...rule, source: "built-in", preset: defaultPhaseOnePresetName })),
  };
}

function loadOptionalPolicyLayer(name: "global" | "local", filePath: string): LoadedPolicyLayer {
  if (!fs.existsSync(filePath)) {
    return {
      name,
      path: filePath,
      loaded: false,
      presets: [],
      rules: [],
    };
  }

  const document = loadPolicyFile(filePath);
  const presetRules = document.presets.flatMap((presetName) => rulesForPreset(presetName, name));
  return {
    name,
    path: filePath,
    loaded: true,
    presets: document.presets,
    rules: [
      ...presetRules,
      ...document.rules.map((rule) => ({ ...rule, source: name })),
    ],
  };
}

function rulesForPreset(presetName: string, source: PolicyLayerName): PhaseOnePolicyRule[] {
  const preset = phaseOnePolicyPresets.find((entry) => entry.name === presetName);
  return (preset?.rules ?? []).map((rule) => ({ ...rule, source, preset: presetName }));
}
