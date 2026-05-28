import type { ParsedAction, ResolvedTargets, RiskResult } from "./types.js";

function isRecursiveDelete(action: ParsedAction): boolean {
  return action.kind === "filesystem.delete" && action.isRecursive;
}

function isWildcardDelete(action: ParsedAction): boolean {
  return action.kind === "filesystem.delete" && action.isWildcard;
}

export function analyzeRisk(action: ParsedAction, targets: ResolvedTargets): RiskResult {
  const signals: string[] = [];
  let score = 0;

  if (action.kind === "sql.destructive") {
    if (action.sqlPattern === "delete-without-where") {
      signals.push("sql destructive without WHERE");
      return {
        decision: "block",
        score: 100,
        reason: "SQL DELETE without WHERE is blocked",
        signals,
      };
    }

    if (action.sqlPattern === "drop-table") {
      signals.push("DROP TABLE detected");
      return {
        decision: "block",
        score: 100,
        reason: "DROP TABLE is blocked",
        signals,
      };
    }

    if (action.sqlPattern === "truncate-table") {
      signals.push("TRUNCATE TABLE detected");
      return {
        decision: "block",
        score: 100,
        reason: "TRUNCATE TABLE is blocked",
        signals,
      };
    }

    signals.push("SQL DELETE with WHERE");
    return {
      decision: "warn",
      score: 45,
      reason: "SQL DELETE with WHERE requires approval",
      signals,
    };
  }

  if (action.kind === "filesystem.delete") {
    score += Math.min(targets.targetCount * 8, 40);
    const hasHardCritical = targets.targetClasses.some(
      (entry) => entry.category === "git-metadata" || entry.category === "home" || entry.category === "filesystem-root",
    );
    const hasDependencyTreeTargets = targets.targetClasses.some((entry) => entry.category === "dependency-tree");

    if (isWildcardDelete(action)) {
      signals.push("wildcard delete");
      score += 35;
    }

    if (isRecursiveDelete(action)) {
      signals.push("recursive delete");
      score += 35;
    }

    if (action.isForce) {
      signals.push("force flag");
      score += 15;
    }

    if (!targets.insideWorkspace || targets.outsideWorkspace) {
      signals.push("outside workspace");
      score += 100;
    }

    if (targets.protectedTargets.length > 0) {
      signals.push(`protected targets: ${targets.protectedTargets.join(", ")}`);
      score += 50;
    }

    if (targets.sensitiveTargets.length > 0) {
      signals.push(`sensitive targets: ${targets.sensitiveTargets.join(", ")}`);
      score += Math.min(30, targets.sensitiveTargets.length * 10);
    }

    if (targets.recoverability === "medium") {
      signals.push("medium recoverability");
      score += 10;
    } else if (targets.recoverability === "low") {
      signals.push("low recoverability");
      score += 25;
    }

    if (!targets.insideWorkspace || targets.protectedTargets.length > 0) {
      return {
        decision: "block",
        score: Math.max(score, 90),
        reason: "filesystem delete is too risky to execute",
        signals,
      };
    }

    if (action.isWildcard || action.isRecursive) {
      if (hasDependencyTreeTargets && !hasHardCritical) {
        signals.push("dependency tree target");
        return {
          decision: "warn",
          score: Math.max(score, 55),
          reason: "dependency tree delete requires approval",
          signals,
        };
      }

      if (targets.sensitiveTargets.length > 0 || targets.recoverability === "low") {
        return {
          decision: "block",
          score: Math.max(score, 90),
          reason: "recursive or wildcard delete against sensitive targets is blocked",
          signals,
        };
      }

      signals.push("broad delete pattern");
      return {
        decision: "warn",
        score: Math.max(score, 60),
        reason: "broad delete pattern requires approval",
        signals,
      };
    }

    if (targets.targetCount > 1) {
      signals.push(`multiple targets: ${targets.targetCount}`);
      score += 15;
    }

    if (targets.sensitiveTargets.length > 0) {
      if (hasDependencyTreeTargets && !hasHardCritical) {
        return {
          decision: "warn",
          score: Math.max(score, 45),
          reason: "dependency tree deletion requires approval",
          signals,
        };
      }

      return {
        decision: "warn",
        score: Math.max(score, 45),
        reason: "sensitive file or directory deletion requires approval",
        signals,
      };
    }

    if (score >= 30) {
      return {
        decision: "warn",
        score,
        reason: "filesystem delete requires approval",
        signals,
      };
    }

    return {
      decision: "allow",
      score,
      reason: "single-file delete is allowed",
      signals,
    };
  }

  if (action.kind === "git.push" && action.isForce) {
    signals.push("force push");
    score = 65;
    if (targets.protectedBranch) {
      signals.push("protected branch");
      return {
        decision: "block",
        score: 95,
        reason: "force push to protected branch is blocked",
        signals,
      };
    }

    return {
      decision: "warn",
      score,
      reason: "force push requires approval",
      signals,
    };
  }

  if (action.kind === "package.publish") {
    signals.push("package publish");
    return {
      decision: "warn",
      score: 55,
      reason: "package publish requires approval because it changes the public release state",
      signals,
    };
  }

  return {
    decision: "allow",
    score,
    reason: "no risky pattern detected",
    signals,
  };
}
