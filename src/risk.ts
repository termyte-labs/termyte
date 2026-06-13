import type { ParsedAction, ResolvedTargets, RiskResult } from "./types.js";

function isRecursiveDelete(action: ParsedAction): boolean {
  return action.kind === "filesystem.delete" && action.isRecursive;
}

function isWildcardDelete(action: ParsedAction): boolean {
  return action.kind === "filesystem.delete" && action.isWildcard;
}

export function analyzeRisk(action: ParsedAction, targets: ResolvedTargets): RiskResult {
  return enrichRisk(action, targets, analyzeRiskCore(action, targets));
}

function analyzeRiskCore(action: ParsedAction, targets: ResolvedTargets): RiskResult {
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

  if (action.kind === "filesystem.write") {
    score += Math.min(targets.targetCount * 5, 25);

    if (!targets.insideWorkspace || targets.outsideWorkspace) {
      signals.push("outside workspace");
      return {
        decision: "block",
        score: 90,
        reason: "filesystem write outside the workspace is blocked",
        signals,
      };
    }

    if (targets.protectedTargets.length > 0) {
      signals.push(`protected targets: ${targets.protectedTargets.join(", ")}`);
      return {
        decision: "block",
        score: 90,
        reason: "filesystem write to protected targets is blocked",
        signals,
      };
    }

    const writeSensitiveTargets = targets.targetClasses.filter((entry) =>
      entry.category === "config" ||
      entry.category === "environment" ||
      entry.category === "git-metadata" ||
      entry.category === "home" ||
      entry.category === "filesystem-root" ||
      entry.category === "workspace-root"
    );
    if (writeSensitiveTargets.length > 0) {
      signals.push(`sensitive targets: ${writeSensitiveTargets.map((entry) => entry.target).join(", ")}`);
      return {
        decision: "warn",
        score: Math.max(score, 45),
        reason: "filesystem write to sensitive files requires approval",
        signals,
      };
    }

    return {
      decision: "allow",
      score,
      reason: "workspace file write is allowed",
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
      decision: "block",
      score: 85,
      reason: "package publishing is blocked because it changes public release state",
      signals,
    };
  }

  if (action.kind === "package.install") {
    signals.push("dependency install");
    return {
      decision: "warn",
      score: 40,
      reason: "dependency installation changes the local dependency graph and may update manifests or lockfiles",
      signals,
    };
  }

  if (action.kind === "git.destructive") {
    signals.push("git destructive history operation");
    return {
      decision: "warn",
      score: 65,
      reason: "git destructive history operation requires approval",
      signals,
    };
  }

  if (action.kind === "remote-script.execution") {
    signals.push("remote script execution");
    return {
      decision: "warn",
      score: 70,
      reason: "remote script execution requires approval",
      signals,
    };
  }

  if (action.kind === "privilege.escalation") {
    signals.push("privilege escalation");
    if (action.semanticId === "permission.chmod_recursive_777") {
      signals.push("recursive world-writable permissions");
      return {
        decision: "block",
        score: 90,
        reason: "recursive chmod 777 is blocked because it makes files world-writable",
        signals,
      };
    }
    return {
      decision: "warn",
      score: 70,
      reason: "privilege escalation requires approval",
      signals,
    };
  }

  if (action.kind === "secret.access") {
    signals.push("secret access");
    return {
      decision: "warn",
      score: 60,
      reason: "secret access requires approval",
      signals,
    };
  }

  if (action.kind === "docker.destructive") {
    signals.push("docker destructive operation");
    return {
      decision: "warn",
      score: 60,
      reason: "docker destructive operation requires approval",
      signals,
    };
  }

  if (action.kind === "deploy.mutation") {
    signals.push("deployment mutation");
    return {
      decision: "warn",
      score: 65,
      reason: "deployment mutation requires approval",
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

function enrichRisk(action: ParsedAction, targets: ResolvedTargets, risk: RiskResult): RiskResult {
  return {
    ...risk,
    level: riskLevel(risk.score),
    ruleId: ruleIdFor(action, targets),
    suggestedFix: suggestedFixFor(action, targets),
  };
}

function riskLevel(score: number): NonNullable<RiskResult["level"]> {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function ruleIdFor(action: ParsedAction, targets: ResolvedTargets): string {
  if (action.kind === "git.push" && action.isForce) {
    return targets.protectedBranch ? "git.push.force.protected_branch" : "git.push.force.any";
  }

  if (action.kind === "git.destructive") {
    if (action.semanticId === "git.reset.hard") return "git.reset.hard";
    if (action.semanticId.startsWith("git.branch.delete")) return "git.branch.delete";
    return action.semanticId;
  }

  if (action.kind === "filesystem.delete") {
    if (targets.targetClasses.some((entry) => entry.category === "git-metadata")) return "file.delete.git_dir";
    if (targets.protectedTargets.length > 0) return "file.delete.protected_path";
    if (targets.targetClasses.some((entry) => entry.category === "workspace-source") && action.isRecursive) return "file.delete.source_dir";
    if (action.isRecursive) return "file.delete.recursive";
    return "file.delete";
  }

  if (action.kind === "filesystem.write") {
    if (targets.protectedTargets.length > 0) return "file.modify.protected_path";
    if (targets.targetClasses.some((entry) => entry.category === "config")) {
      const targetText = targets.expandedTargets.join(" ").toLowerCase();
      if (/package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock/.test(targetText)) {
        return targetText.includes("lock") ? "package.lockfile.modify" : "package.manifest.modify";
      }
      if (targetText.includes(".github")) return "ci.modify";
      if (/dockerfile|docker-compose\.ya?ml/.test(targetText)) return "docker.modify";
      if (/infra|terraform|migrations/.test(targetText)) return targetText.includes("migrations") ? "migration.run" : "infra.modify";
    }
    return "file.modify";
  }

  if (action.kind === "secret.access") {
    const target = action.target.toLowerCase();
    if (target.includes(".env")) return "secret.read.env";
    if (/id_rsa|\.pem|\.key/.test(target)) return "secret.read.private_key";
    return "secret.possible_exfiltration";
  }

  if (action.kind === "package.publish") return "package.publish";
  if (action.kind === "package.install") return "package.install";

  if (action.kind === "sql.destructive") {
    if (action.sqlPattern === "drop-table") return "db.drop";
    if (action.sqlPattern === "truncate-table") return "db.truncate";
    if (action.sqlPattern === "delete-without-where") return "db.delete_without_where";
    return "db.delete_with_where";
  }

  if (action.kind === "remote-script.execution") {
    const first = action.tokens[0]?.toLowerCase() ?? "";
    if (first === "wget") return "network.wget_pipe_shell";
    return "network.curl_pipe_shell";
  }

  if (action.kind === "docker.destructive") return "docker.modify";
  if (action.kind === "deploy.mutation") {
    const first = action.tokens[0]?.toLowerCase() ?? "";
    if (first === "prisma" || first === "alembic") return "migration.run";
    if (first === "terraform" || first === "kubectl") return "infra.modify";
    return "deploy.command";
  }
  if (action.kind === "privilege.escalation") {
    return action.rawCommand.toLowerCase().includes("chmod -r 777") ? "permission.chmod_recursive_777" : "sudo.destructive";
  }

  if (action.kind === "shell.generic" && action.confidence < 0.6 && action.rawCommand.length > 160) {
    return "unknown.high_entropy_command";
  }

  return action.semanticId;
}

function suggestedFixFor(action: ParsedAction, targets: ResolvedTargets): string {
  if (action.kind === "git.push" && action.isForce) {
    return targets.protectedBranch ? "Create a feature branch or use a normal push after review." : "Prefer --force-with-lease on a feature branch after review.";
  }
  if (action.kind === "filesystem.delete") return "Delete narrower targets and inspect them first.";
  if (action.kind === "filesystem.write" && targets.protectedTargets.length > 0) return "Move the change to a reviewed branch or edit a non-protected file.";
  if (action.kind === "secret.access") return "Use a secret manager or request explicit approval for secret access.";
  if (action.kind === "package.publish") return "Run a pack or dry-run release step first.";
  if (action.kind === "package.install") return "Review manifest and lockfile changes before committing.";
  if (action.kind === "sql.destructive") return "Run the SQL in a disposable database or add a narrow WHERE clause.";
  if (action.kind === "remote-script.execution") return "Download and inspect the script before execution.";
  if (action.kind === "privilege.escalation") return "Run the least-privileged command that performs the same operation.";
  if (action.kind === "docker.destructive") return "Inspect Docker resources and target only the specific resource.";
  if (action.kind === "deploy.mutation") return "Run a plan/dry-run and require review before mutating deployment state.";
  return "Run `termyte inspect` before executing or split the action into a smaller step.";
}
