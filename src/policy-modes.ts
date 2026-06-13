import type { Decision, RiskResult } from "./types.js";
import type { PolicyMode } from "./policy-schema.js";

export interface ModeDecisionResult {
  decision: Decision;
  reasonSuffix?: string;
}

export function applyPolicyMode(decision: Decision, risk: RiskResult, mode: PolicyMode): ModeDecisionResult {
  if (mode === "off") {
    return {
      decision: "allow",
      reasonSuffix: `Policy mode off: Termyte would have returned ${decision}.`,
    };
  }

  if (mode === "observe") {
    return {
      decision: "allow",
      reasonSuffix: `Policy mode observe: Termyte logged the action but did not enforce the ${decision} decision.`,
    };
  }

  if (mode === "strict") {
    if (risk.score >= 60 && decision !== "block") {
      return {
        decision: "block",
        reasonSuffix: "Policy mode strict: high-risk actions are blocked.",
      };
    }
    if (risk.score >= 30 && decision === "warn") {
      return {
        decision: "ask",
        reasonSuffix: "Policy mode strict: medium-risk warnings require approval.",
      };
    }
  }

  if (mode === "paranoid") {
    if (risk.score >= 60 && decision !== "block") {
      return {
        decision: "block",
        reasonSuffix: "Policy mode paranoid: high-risk actions are blocked.",
      };
    }
    if (decision === "warn") {
      return {
        decision: "ask",
        reasonSuffix: "Policy mode paranoid: warnings require approval.",
      };
    }
  }

  return { decision };
}
