import { describe, expect, it } from "vitest";
import type { LoadedPolicies } from "../src/policy-loader.js";
import { mergePhaseOnePolicies } from "../src/policy-merge.js";
import { evaluatePhaseOnePolicy } from "../src/policy-evaluator.js";
import { parseAction } from "../src/parser.js";
import { resolveTargets } from "../src/resolver.js";
import { analyzeRisk } from "../src/risk.js";

function evaluate(command: string, loaded: LoadedPolicies) {
  const action = parseAction(command);
  const targets = resolveTargets(action, process.cwd());
  return evaluatePhaseOnePolicy(action, targets, analyzeRisk(action, targets), mergePhaseOnePolicies(loaded));
}

describe("Phase 1 policy merge and conflict resolution", () => {
  it("applies block > ask > warn > allow across layers", () => {
    const loaded: LoadedPolicies = {
      warnings: [],
      layers: [
        { name: "built-in", path: null, loaded: true, presets: ["safe-default"], rules: [{ name: "built-in allow", action: "allow", source: "built-in", match: { semantic_ids: ["shell.generic"] } }] },
        { name: "global", path: null, loaded: true, presets: [], rules: [{ name: "global ask", action: "ask", source: "global", match: { semantic_ids: ["shell.generic"] } }] },
        { name: "local", path: null, loaded: true, presets: [], rules: [{ name: "local warn", action: "warn", source: "local", match: { semantic_ids: ["shell.generic"] } }] },
      ],
    };

    expect(evaluate("echo hi", loaded).decision).toBe("ask");

    loaded.layers[2].rules.push({ name: "local block", action: "block", source: "local", match: { semantic_ids: ["shell.generic"] } });
    expect(evaluate("echo hi", loaded).decision).toBe("block");
  });

  it("does not let higher source priority weaken built-in blocks", () => {
    const loaded: LoadedPolicies = {
      warnings: [],
      layers: [
        { name: "built-in", path: null, loaded: true, presets: ["safe-default"], rules: [{ name: "built-in block", action: "block", source: "built-in", match: { semantic_ids: ["secret.access"] } }] },
        { name: "global", path: null, loaded: true, presets: [], rules: [] },
        { name: "local", path: null, loaded: true, presets: [], rules: [{ name: "local allow", action: "allow", source: "local", match: { semantic_ids: ["secret.access"] } }] },
      ],
    };

    expect(evaluate("cat .env", loaded).decision).toBe("block");
  });
});
