import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentRunPlan } from "./agent.js";
import { listLocalLogs } from "./local-logs.js";
import { listLocalMemory } from "./local-memory.js";
import { ensureLocalStateDir, type LocalStatePaths } from "./local-state.js";
import { loadPhaseOnePolicies } from "./policy-loader.js";
import { mergePhaseOnePolicies, type EffectivePhaseOnePolicy } from "./policy-merge.js";

export type AgentRuntimeMode = "limited" | "intercepted" | "unavailable";

export interface AgentRunReadiness {
  repoRoot: string;
  repoName: string;
  insideGitRepo: boolean;
  sessionId: string;
  state: LocalStatePaths;
  policy: EffectivePhaseOnePolicy;
  logs: "enabled";
  memory: "enabled";
  runtimeMode: AgentRuntimeMode;
}

export interface AgentRunResult {
  exitCode: number;
  launched: boolean;
  readiness?: AgentRunReadiness;
}

export async function runAgent(plan: AgentRunPlan): Promise<AgentRunResult> {
  if (!plan.executableFound) {
    process.stderr.write(`${formatMissingAgentError(plan)}\n`);
    return { exitCode: 1, launched: false };
  }

  let readiness: AgentRunReadiness;
  try {
    readiness = prepareAgentRun(plan.workspaceRoot);
  } catch (error) {
    process.stderr.write(`Termyte could not prepare the agent runtime.\n\n${errorMessage(error)}\n\nTry:\n  termyte doctor\n`);
    return { exitCode: 1, launched: false };
  }

  process.stdout.write(`${formatAgentStartupBanner(plan, readiness)}\n`);
  const exitCode = await launchAgentProcess(plan, readiness);
  return { exitCode, launched: true, readiness };
}

export function prepareAgentRun(cwd: string): AgentRunReadiness {
  const repository = detectRepository(cwd);
  const state = ensureLocalStateDir(repository.repoRoot);
  assertStateReady(state);
  const policy = mergePhaseOnePolicies(loadPhaseOnePolicies(repository.repoRoot));

  return {
    ...repository,
    sessionId: createSessionId(),
    state,
    policy,
    logs: "enabled",
    memory: "enabled",
    runtimeMode: "limited",
  };
}

export function detectRepository(cwd: string): { repoRoot: string; repoName: string; insideGitRepo: boolean } {
  const resolvedCwd = path.resolve(cwd);
  let current = resolvedCwd;

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return { repoRoot: current, repoName: path.basename(current), insideGitRepo: true };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return { repoRoot: resolvedCwd, repoName: path.basename(resolvedCwd), insideGitRepo: false };
}

export function formatMissingAgentError(plan: AgentRunPlan): string {
  const lines = [
    `Termyte could not find the agent executable: ${plan.agentName}`,
    ...(plan.attemptedExecutables.length > 1 ? ["", `Tried: ${plan.attemptedExecutables.join(", ")}`] : []),
  ];
  if (plan.agentName === "codex") {
    lines.push("", "Try:", "  npm install -g @openai/codex");
  }
  lines.push("", "Or run:", "  termyte doctor");
  return lines.join("\n");
}

export function formatAgentStartupBanner(plan: AgentRunPlan, readiness: AgentRunReadiness): string {
  const layer = (name: "global" | "local"): string =>
    readiness.policy.layers.find((candidate) => candidate.name === name)?.loaded ? "active" : "none";
  const builtIn = readiness.policy.layers.find((candidate) => candidate.name === "built-in")?.presets ?? [];

  return [
    "Termyte Safe Runtime",
    "",
    `Repo: ${readiness.repoName}`,
    `Agent: ${plan.agentName}`,
    `Session: ${readiness.sessionId}`,
    "",
    "Policy:",
    `  built-in: ${builtIn.join(", ") || "none"}`,
    `  global: ${layer("global")}`,
    `  local: ${layer("local")}`,
    "",
    "State:",
    `  logs: ${readiness.logs}`,
    `  memory: ${readiness.memory}`,
    "",
    "Runtime mode:",
    `  ${readiness.runtimeMode}`,
    "",
    "Note:",
    "  Termyte prepared policy, logs, memory, and session context.",
    "  Full subprocess interception is experimental on this platform.",
    "",
    "Running:",
    `  ${plan.resolvedAgentName}`,
  ].join("\n");
}

function assertStateReady(state: LocalStatePaths): void {
  fs.accessSync(state.stateDir, fs.constants.R_OK | fs.constants.W_OK);
  listLocalLogs(state.cwd);
  listLocalMemory(state.cwd);
}

function createSessionId(): string {
  return `tm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function launchAgentProcess(plan: AgentRunPlan, readiness: AgentRunReadiness): Promise<number> {
  return await new Promise<number>((resolve) => {
    const isWindowsCommandScript = process.platform === "win32" && /\.(cmd|bat)$/i.test(plan.resolvedExecutable);
    const child = spawn(plan.resolvedExecutable, plan.agentArgs, {
      cwd: plan.workspaceRoot,
      env: {
        ...process.env,
        TERMYTE_SESSION_ID: readiness.sessionId,
        TERMYTE_AGENT: plan.agentName,
        TERMYTE_RESOLVED_AGENT: plan.resolvedAgentName,
        TERMYTE_WORKSPACE_ROOT: readiness.repoRoot,
        TERMYTE_RUNTIME_MODE: readiness.runtimeMode,
      },
      stdio: "inherit",
      shell: isWindowsCommandScript,
    });

    child.once("error", (error) => {
      process.stderr.write(`Termyte could not start the agent executable: ${plan.agentName}\n${cleanSpawnError(error)}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`Termyte agent process exited after signal: ${signal}\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function cleanSpawnError(error: Error): string {
  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
  return code ? `Process launch failed (${code}). Run \`termyte doctor\` for details.` : "Process launch failed. Run `termyte doctor` for details.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
