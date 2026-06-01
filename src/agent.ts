import path from "node:path";
import type { GovernedSession } from "./shell.js";
import { DEFAULT_SHIM_TOOLS, HIGH_VALUE_SHIMS, SHELL_HOST_SHIMS, resolveSessionLaunchCommand } from "./shell.js";

export type AgentName = "codex" | "claude" | "aider";
export type RuntimeProfileName = "default" | "codex-windows" | "codex-unix" | "claude-windows" | "claude-unix" | "aider";
export type ShellHookStrategy = "default-hooks" | "disabled";

export interface RuntimeProfile {
  name: RuntimeProfileName;
  enabledShims: string[];
  disabledShims: string[];
  shellHooksEnabled: boolean;
  shellHookStrategy: ShellHookStrategy;
  knownCompatibilityNotes: string[];
}

export interface RunInvocation {
  dryRun: boolean;
  profileName?: RuntimeProfileName;
  mode: "agent" | "command";
  agentName?: AgentName;
  agentArgs: string[];
  command?: string[];
}

export interface AgentRunPlan {
  agentName: AgentName;
  agentArgs: string[];
  resolvedExecutable: string;
  resolvedArgs: string[];
  runtimeProfile: RuntimeProfile;
  workspaceRoot: string;
  dbPath: string;
  platform: NodeJS.Platform;
  warnings: string[];
}

export function isSupportedAgentName(value: string): value is AgentName {
  return value === "codex" || value === "claude" || value === "aider";
}

export function isRuntimeProfileName(value: string): value is RuntimeProfileName {
  return value === "default" || value === "codex-windows" || value === "codex-unix" || value === "claude-windows" || value === "claude-unix" || value === "aider";
}

export function parseRunInvocation(args: string[]): RunInvocation {
  let index = 0;
  let dryRun = false;
  let profileName: RuntimeProfileName | undefined;

  while (index < args.length) {
    const token = args[index];
    if (token === "--dry-run") {
      dryRun = true;
      index += 1;
      continue;
    }
    if (token === "--profile") {
      const profile = args[index + 1];
      if (!profile) {
        throw new Error("Missing profile name after `--profile`.");
      }
      if (!isRuntimeProfileName(profile)) {
        throw new Error(`Unknown runtime profile: ${profile}`);
      }
      profileName = profile;
      index += 2;
      continue;
    }
    break;
  }

  const remaining = args.slice(index);
  if (remaining[0] === "--") {
    return {
      dryRun,
      profileName,
      mode: "command",
      command: remaining.slice(1),
      agentArgs: [],
    };
  }

  const agentName = remaining[0];
  if (!agentName) {
    throw new Error("Missing agent name. Use `termyte run <agent>` or `termyte run -- <command>`.");
  }
  if (!isSupportedAgentName(agentName)) {
    throw new Error(
      `Unknown agent: ${agentName}. Supported agents: codex, claude, aider. For generic commands, use \`termyte run -- <command>\` or \`termyte shell -- <command>\`.`,
    );
  }

  return {
    dryRun,
    profileName,
    mode: "agent",
    agentName,
    agentArgs: remaining.slice(1),
  };
}

export function resolveRuntimeProfile(agentName: AgentName, platform: NodeJS.Platform, requestedProfile?: RuntimeProfileName): RuntimeProfile {
  const profileName = requestedProfile ?? defaultProfileForAgent(agentName, platform);
  switch (profileName) {
    case "default":
      return {
        name: "default",
        enabledShims: [...DEFAULT_SHIM_TOOLS],
        disabledShims: [],
        shellHooksEnabled: true,
        shellHookStrategy: "default-hooks",
        knownCompatibilityNotes: ["Generic governed session with full shim coverage."],
      };
    case "codex-windows":
      return {
        name: "codex-windows",
        enabledShims: [...HIGH_VALUE_SHIMS],
        disabledShims: [...SHELL_HOST_SHIMS],
        shellHooksEnabled: false,
        shellHookStrategy: "disabled",
        knownCompatibilityNotes: [
          "Shell-host shims are disabled to avoid conflicts with Codex's internal shell runner on Windows.",
        ],
      };
    case "codex-unix":
      return {
        name: "codex-unix",
        enabledShims: [...DEFAULT_SHIM_TOOLS],
        disabledShims: [],
        shellHooksEnabled: true,
        shellHookStrategy: "default-hooks",
        knownCompatibilityNotes: ["Uses the standard governed shell runtime on Unix-like systems."],
      };
    case "claude-windows":
      return {
        name: "claude-windows",
        enabledShims: [...DEFAULT_SHIM_TOOLS],
        disabledShims: [],
        shellHooksEnabled: true,
        shellHookStrategy: "default-hooks",
        knownCompatibilityNotes: ["Uses the standard governed shell runtime on Windows."],
      };
    case "claude-unix":
      return {
        name: "claude-unix",
        enabledShims: [...DEFAULT_SHIM_TOOLS],
        disabledShims: [],
        shellHooksEnabled: true,
        shellHookStrategy: "default-hooks",
        knownCompatibilityNotes: ["Uses the standard governed shell runtime on Unix-like systems."],
      };
    case "aider":
      return {
        name: "aider",
        enabledShims: [...DEFAULT_SHIM_TOOLS],
        disabledShims: [],
        shellHooksEnabled: true,
        shellHookStrategy: "default-hooks",
        knownCompatibilityNotes: ["Uses the default governed session without agent-specific shim exclusions."],
      };
    default:
      throw new Error(`Unknown runtime profile: ${profileName}`);
  }
}

export function buildAgentRunPlan(options: {
  workspaceRoot: string;
  dbPath: string;
  agentName: AgentName;
  agentArgs: string[];
  profileName?: RuntimeProfileName;
  platform?: NodeJS.Platform;
  originalPath?: string;
}): AgentRunPlan {
  const platform = options.platform ?? process.platform;
  const runtimeProfile = resolveRuntimeProfile(options.agentName, platform, options.profileName);
  const originalPath = options.originalPath ?? process.env.TERMYTE_ORIGINAL_PATH ?? process.env.PATH ?? "";
  const sessionLike = {
    originalPath,
    shimDir: path.join(options.workspaceRoot, ".termyte", "preview", "shims"),
  } as unknown as GovernedSession;
  const resolvedExecutable = resolveSessionLaunchCommand(options.agentName, sessionLike, options.agentArgs, { platform });
  const warnings = buildRuntimeWarnings(runtimeProfile);

  return {
    agentName: options.agentName,
    agentArgs: [...options.agentArgs],
    resolvedExecutable,
    resolvedArgs: [...options.agentArgs],
    runtimeProfile,
    workspaceRoot: options.workspaceRoot,
    dbPath: options.dbPath,
    platform,
    warnings,
  };
}

export function buildAgentRuntimeMetadata(plan: AgentRunPlan): {
  launchedVia: "termyte-run";
  runtimeProfile: RuntimeProfileName;
  agentName: AgentName;
  agentCommand: string;
  agentArgs: string[];
  enabledShims: string[];
  disabledShims: string[];
  shellHooksEnabled: boolean;
  shellHookStrategy: ShellHookStrategy;
  knownCompatibilityNotes: string[];
  warnings: string[];
} {
  return {
    launchedVia: "termyte-run",
    runtimeProfile: plan.runtimeProfile.name,
    agentName: plan.agentName,
    agentCommand: plan.resolvedExecutable,
    agentArgs: [...plan.resolvedArgs],
    enabledShims: [...plan.runtimeProfile.enabledShims],
    disabledShims: [...plan.runtimeProfile.disabledShims],
    shellHooksEnabled: plan.runtimeProfile.shellHooksEnabled,
    shellHookStrategy: plan.runtimeProfile.shellHookStrategy,
    knownCompatibilityNotes: [...plan.runtimeProfile.knownCompatibilityNotes],
    warnings: [...plan.warnings],
  };
}

export function formatAgentDryRunReport(plan: AgentRunPlan): string {
  const lines = [
    "Termyte agent run dry run",
    `  agent: ${plan.agentName}`,
    `  profile: ${plan.runtimeProfile.name}`,
    `  platform: ${plan.platform}`,
    `  workspace root: ${plan.workspaceRoot}`,
    `  db path: ${plan.dbPath}`,
    `  resolved executable: ${plan.resolvedExecutable}`,
    `  resolved args: ${plan.resolvedArgs.length > 0 ? plan.resolvedArgs.join(" ") : "(none)"}`,
    `  enabled shims: ${plan.runtimeProfile.enabledShims.join(", ") || "(none)"}`,
    `  disabled shims: ${plan.runtimeProfile.disabledShims.length > 0 ? plan.runtimeProfile.disabledShims.join(", ") : "(none)"}`,
    `  shell hooks: ${plan.runtimeProfile.shellHooksEnabled ? "enabled" : "disabled"}`,
    `  shell hook strategy: ${plan.runtimeProfile.shellHookStrategy}`,
    "  known limitations:",
  ];

  for (const note of plan.runtimeProfile.knownCompatibilityNotes) {
    lines.push(`    - ${note}`);
  }
  if (plan.runtimeProfile.knownCompatibilityNotes.length === 0) {
    lines.push("    - none");
  }

  lines.push("  warnings:");
  for (const warning of plan.warnings) {
    lines.push(`    - ${warning}`);
  }
  if (plan.warnings.length === 0) {
    lines.push("    - none");
  }

  return lines.join("\n");
}

function defaultProfileForAgent(agentName: AgentName, platform: NodeJS.Platform): RuntimeProfileName {
  if (agentName === "codex") {
    return platform === "win32" ? "codex-windows" : "codex-unix";
  }
  if (agentName === "claude") {
    return platform === "win32" ? "claude-windows" : "claude-unix";
  }
  return "aider";
}

function buildRuntimeWarnings(profile: RuntimeProfile): string[] {
  const warnings: string[] = [];
  if (profile.disabledShims.length > 0) {
    warnings.push(`Disabled shims: ${profile.disabledShims.join(", ")}`);
  }
  if (!profile.shellHooksEnabled) {
    warnings.push("Shell hooks are disabled for this runtime profile.");
  }
  return warnings;
}
