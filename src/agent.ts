import fs from "node:fs";
import path from "node:path";
import type { GovernedRuntimeMetadata } from "./shell.js";

export interface RunInvocation {
  dryRun: boolean;
  profileName?: string;
  mode: "agent" | "command";
  agentName?: string;
  agentArgs: string[];
  command?: string[];
}

export interface RuntimeProfile {
  name: string;
  enabledShims: string[];
  disabledShims: string[];
  shellHooksEnabled: boolean;
  shellHookStrategy: string;
  knownCompatibilityNotes: string[];
}

export interface AgentRunPlan {
  workspaceRoot: string;
  dbPath: string;
  agentName: string;
  agentArgs: string[];
  profileName?: string;
  resolvedExecutable: string;
  resolvedAgentName: string;
  attemptedExecutables: string[];
  executableFound: boolean;
  runtimeProfile: RuntimeProfile;
  warnings: string[];
}

export interface AgentExecutableResolution {
  requestedAgent: string;
  attemptedExecutables: string[];
  resolvedAgentName: string | null;
  resolvedExecutable: string | null;
}

const SUPPORTED_AGENTS = ["codex", "claude", "claudecode", "aider"];
const HIGH_VALUE_SHIMS = ["git", "npm", "pnpm", "yarn", "npx", "node", "python", "pip", "docker"];
const SHELL_HOST_SHIMS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"];
const DEFAULT_SHIMS = [...HIGH_VALUE_SHIMS, ...SHELL_HOST_SHIMS];

export function parseRunInvocation(args: string[]): RunInvocation {
  const dryRun = args.includes("--dry-run");
  const profileIndex = args.indexOf("--profile");
  const profileName = profileIndex >= 0 ? args[profileIndex + 1] : undefined;
  const filtered = args.filter((token, index) => {
    if (token === "--dry-run") return false;
    if (profileIndex >= 0 && (index === profileIndex || index === profileIndex + 1)) return false;
    return true;
  });
  const separatorIndex = filtered.indexOf("--");
  if (separatorIndex >= 0) {
    return {
      dryRun,
      profileName,
      mode: "command",
      agentArgs: [],
      command: filtered.slice(separatorIndex + 1),
    };
  }

  const agentName = filtered[0];
  if (agentName && !isSupportedAgentName(agentName)) {
    throw new Error(`Unknown agent: ${agentName}. Supported agents: ${SUPPORTED_AGENTS.join(", ")}.`);
  }

  return {
    dryRun,
    profileName,
    mode: "agent",
    agentName,
    agentArgs: filtered.slice(1),
  };
}

export function buildAgentRunPlan(options: {
  workspaceRoot: string;
  dbPath: string;
  agentName: string;
  agentArgs: string[];
  profileName?: string;
  originalPath?: string;
  platform?: NodeJS.Platform;
}): AgentRunPlan {
  if (!isSupportedAgentName(options.agentName)) {
    throw new Error(`Unknown agent: ${options.agentName}. Supported agents: ${SUPPORTED_AGENTS.join(", ")}.`);
  }

  const runtimeProfile = resolveRuntimeProfile(options.agentName, options.platform ?? process.platform, options.profileName ?? "default");
  const resolution = resolveAgentExecutable(
    options.agentName,
    options.originalPath ?? process.env.PATH ?? "",
    options.platform ?? process.platform,
  );
  const executableFound = resolution.resolvedExecutable !== null;
  const warnings = executableFound ? [] : [`${options.agentName} executable was not found on PATH`];

  return {
    workspaceRoot: options.workspaceRoot,
    dbPath: options.dbPath,
    agentName: options.agentName,
    agentArgs: options.agentArgs,
    profileName: options.profileName,
    resolvedExecutable: resolution.resolvedExecutable ?? options.agentName,
    resolvedAgentName: resolution.resolvedAgentName ?? options.agentName,
    attemptedExecutables: resolution.attemptedExecutables,
    executableFound,
    runtimeProfile,
    warnings,
  };
}

export function buildAgentRuntimeMetadata(plan: AgentRunPlan): GovernedRuntimeMetadata {
  return {
    launchedVia: "termyte-run",
    runtimeProfile: plan.runtimeProfile.name,
    agentName: plan.agentName,
    agentCommand: plan.resolvedExecutable,
    agentArgs: plan.agentArgs,
    enabledShims: plan.runtimeProfile.enabledShims,
    disabledShims: plan.runtimeProfile.disabledShims,
    shellHooksEnabled: plan.runtimeProfile.shellHooksEnabled,
    shellHookStrategy: plan.runtimeProfile.shellHookStrategy,
    knownCompatibilityNotes: plan.runtimeProfile.knownCompatibilityNotes,
    warnings: plan.warnings,
  };
}

export function formatAgentDryRunReport(plan: AgentRunPlan): string {
  return [
    "Termyte agent run plan",
    `  agent: ${plan.agentName}`,
    `  args: ${plan.agentArgs.join(" ") || "none"}`,
    `  profile: ${plan.runtimeProfile.name}`,
    `  resolved executable: ${plan.executableFound ? plan.resolvedExecutable : `${plan.agentName} (not found on PATH)`}`,
    ...(plan.resolvedAgentName !== plan.agentName ? [`  resolved alias: ${plan.agentName} -> ${plan.resolvedAgentName}`] : []),
    `  enabled shims: ${plan.runtimeProfile.enabledShims.join(", ") || "none"}`,
    `  disabled shims: ${plan.runtimeProfile.disabledShims.join(", ") || "none"}`,
    `  shell hooks: ${plan.runtimeProfile.shellHooksEnabled ? "enabled" : "disabled"}`,
    ...plan.warnings.map((warning) => `  warning: ${warning}`),
  ].join("\n");
}

export function isSupportedAgentName(agentName: string): boolean {
  return SUPPORTED_AGENTS.includes(agentName);
}

export function resolveAgentExecutable(
  agentName: string,
  originalPath: string,
  platform: NodeJS.Platform = process.platform,
  pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
): AgentExecutableResolution {
  const attemptedExecutables = agentExecutableAliases(agentName);
  for (const candidateAgent of attemptedExecutables) {
    const resolvedExecutable = resolveExecutable(candidateAgent, originalPath, platform, pathext);
    if (resolvedExecutable) {
      return {
        requestedAgent: agentName,
        attemptedExecutables,
        resolvedAgentName: candidateAgent,
        resolvedExecutable,
      };
    }
  }
  return {
    requestedAgent: agentName,
    attemptedExecutables,
    resolvedAgentName: null,
    resolvedExecutable: null,
  };
}

export function resolveRuntimeProfile(agentName: string, platform: NodeJS.Platform = process.platform, profileName = "default"): RuntimeProfile {
  if (profileName === "codex-windows" && agentName === "codex" && platform === "win32") {
    return {
      name: "codex-windows",
      enabledShims: [...HIGH_VALUE_SHIMS],
      disabledShims: [...SHELL_HOST_SHIMS],
      shellHooksEnabled: false,
      shellHookStrategy: "disabled",
      knownCompatibilityNotes: ["Codex on Windows keeps command shims enabled and shell-host shims disabled."],
    };
  }

  return {
    name: profileName,
    enabledShims: [...DEFAULT_SHIMS],
    disabledShims: [],
    shellHooksEnabled: true,
    shellHookStrategy: "default",
    knownCompatibilityNotes: [],
  };
}

function agentExecutableAliases(agentName: string): string[] {
  return agentName === "claudecode" ? ["claudecode", "claude"] : [agentName];
}

function resolveExecutable(command: string, originalPath: string, platform: NodeJS.Platform, pathext: string): string | null {
  const candidateNames = executableCandidateNames(command, platform, pathext);
  for (const entry of originalPath.split(path.delimiter).filter(Boolean)) {
    for (const candidateName of candidateNames) {
      const candidate = path.join(entry, candidateName);
      if (isExecutable(candidate, platform)) {
        return candidate;
      }
    }
  }
  return null;
}

function executableCandidateNames(command: string, platform: NodeJS.Platform, pathext: string): string[] {
  if (path.extname(command)) {
    return [command];
  }
  if (platform === "win32") {
    const extensions = pathext
      .split(";")
      .map((extension) => extension.trim().toLowerCase())
      .filter(Boolean);
    return [command, ...extensions.map((extension) => `${command}${extension}`)];
  }
  return [command];
}

function isExecutable(filePath: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
