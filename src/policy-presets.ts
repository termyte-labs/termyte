import type { PhaseOnePolicyRule } from "./policy-schema.js";

export interface PolicyPreset {
  name: string;
  description: string;
  rules: PhaseOnePolicyRule[];
}

export const phaseOnePolicyPresets: PolicyPreset[] = [
  {
    name: "safe-default",
    description: "Local OSS default guardrails for secrets, destructive deletes, protected git pushes, SQL destruction, publishing, remote scripts, deploys, and elevation.",
    rules: [
      rule("block secret access", "block", ["secret.access"]),
      rule("block destructive filesystem deletes", "block", [
        "filesystem.delete.recursive.force.wildcard",
        "filesystem.delete.wildcard",
      ]),
      rule("block protected branch force push", "block", ["git.push.force"]),
      rule("block destructive SQL", "block", ["sql.drop-table", "sql.truncate-table", "sql.delete-without-where"]),
      rule("block package publish", "block", ["package.*.publish"]),
      rule("warn package installs", "warn", ["package.*.install"]),
      rule("warn remote script execution", "warn", ["remote-script.*"]),
      rule("warn deploy mutation", "warn", ["deploy.*"]),
      rule("warn privilege escalation", "warn", ["privilege.escalation"]),
    ],
  },
  {
    name: "strict-filesystem",
    description: "Stricter filesystem delete guardrails for broad, recursive, forced, and wildcard deletes.",
    rules: [
      rule("block recursive forced deletes", "block", ["filesystem.delete.recursive.force"]),
      rule("block wildcard deletes", "block", ["filesystem.delete.wildcard"]),
    ],
  },
  {
    name: "git-safe",
    description: "Guardrails for force pushes and destructive git history operations.",
    rules: [
      rule("block git force push", "block", ["git.push.force"]),
      rule("warn destructive git history", "warn", ["git.reset.*", "git.clean.*", "git.checkout.force", "git.branch.delete.force", "git.tag.delete", "git.stash.drop", "git.reflog.expire"]),
    ],
  },
  {
    name: "secrets-guard",
    description: "Blocks commands that read local secrets or credentials.",
    rules: [rule("block secret reads", "block", ["secret.access"])],
  },
  {
    name: "deploy-guard",
    description: "Warns before deployment and infrastructure mutation commands.",
    rules: [rule("warn deploy mutations", "warn", ["deploy.*"])],
  },
  {
    name: "package-manager-safe",
    description: "Warns before package installs, publishing, and public release mutations.",
    rules: [
      rule("warn package install", "warn", ["package.*.install"]),
      rule("block package publish", "block", ["package.*.publish"]),
    ],
  },
  {
    name: "ci-safe",
    description: "Warns when checks touch CI configuration targets that the Phase 1 resolver can see.",
    rules: [
      {
        name: "warn CI config paths",
        action: "warn",
        match: {
          paths: [".github", ".github/workflows"],
        },
      },
    ],
  },
  {
    name: "dangerous-tools",
    description: "Blocks or warns on destructive tools and privilege escalation.",
    rules: [
      rule("block destructive docker cleanup", "block", ["docker.system.prune"]),
      rule("warn docker destruction", "warn", ["docker.*"]),
      rule("warn privilege escalation", "warn", ["privilege.escalation"]),
      rule("warn remote scripts", "warn", ["remote-script.*"]),
    ],
  },
];

export const defaultPhaseOnePresetName = "safe-default";

export function presetNames(): Set<string> {
  return new Set(phaseOnePolicyPresets.map((preset) => preset.name));
}

function rule(name: string, action: PhaseOnePolicyRule["action"], semanticIds: string[]): PhaseOnePolicyRule {
  return {
    name,
    action,
    match: {
      semantic_ids: semanticIds,
    },
  };
}
