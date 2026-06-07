import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { buildAgentRuntimeMetadata, type AgentRunPlan } from "./agent.js";
import { formatAgentHookVerification, isNativeHookAgent, verifyAgentHooks } from "./agent-hook.js";
import { listLocalLogs } from "./local-logs.js";
import { listLocalMemory } from "./local-memory.js";
import { ensureLocalStateDir, type LocalStatePaths } from "./local-state.js";
import { loadPhaseOnePolicies } from "./policy-loader.js";
import { mergePhaseOnePolicies, type EffectivePhaseOnePolicy } from "./policy-merge.js";
import { launchGovernedSession } from "./shell.js";

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

  if (isNativeHookAgent(plan.resolvedAgentName)) {
    const hookVerification = verifyAgentHooks(plan.resolvedAgentName, detectRepository(plan.workspaceRoot).repoRoot);
    if (!hookVerification.ok) {
      process.stderr.write(`${formatAgentHookVerification(hookVerification)}\n`);
      return { exitCode: 1, launched: false };
    }
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
    runtimeMode: "intercepted",
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
    "  Termyte is launching the agent inside a governed session.",
    "  Supported subprocess tools route through local policy, approvals, and ledger.",
    "  This is interception, not a full OS sandbox.",
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
  try {
    return await launchGovernedSession({
      workspaceRoot: readiness.repoRoot,
      sessionId: readiness.sessionId,
      agentArgs: [plan.resolvedExecutable, ...plan.agentArgs],
      shimTools: plan.runtimeProfile.enabledShims,
      shellHooksEnabled: plan.runtimeProfile.shellHooksEnabled,
      runtimeMetadata: buildAgentRuntimeMetadata(plan),
    });
  } catch (error) {
    process.stderr.write(`Termyte could not start the governed agent runtime: ${plan.agentName}\n${errorMessage(error)}\n\nTry:\n  termyte doctor\n`);
    return 1;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
