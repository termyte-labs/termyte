import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultDbPath, openDatabase } from "./db.js";
import type { AgentRunPlan } from "./agent.js";

export type AgentRuntimeMode = "direct" | "unavailable";

export interface AgentRunReadiness {
  repoRoot: string;
  repoName: string;
  insideGitRepo: boolean;
  sessionId: string;
  dbPath: string;
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
  const dbPath = defaultDbPath(repository.repoRoot);
  openDatabase(dbPath);

  return {
    ...repository,
    sessionId: createSessionId(),
    dbPath,
    runtimeMode: "direct",
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
  return [
    "Termyte Agent Launcher",
    "",
    `Repo: ${readiness.repoName}`,
    `Agent: ${plan.agentName}`,
    `Session: ${readiness.sessionId}`,
    "",
    `Database: ${readiness.dbPath}`,
    "",
    "Launch mode:",
    `  ${readiness.runtimeMode}`,
    "",
    "Note:",
    "  This is a direct launch. Governed command inspection lives in `termyte run -- <command>` and `termyte mcp serve`.",
    "",
    "Running:",
    `  ${plan.resolvedAgentName}`,
  ].join("\n");
}

function createSessionId(): string {
  return `tm_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function launchAgentProcess(plan: AgentRunPlan, readiness: AgentRunReadiness): Promise<number> {
  const env = {
    ...process.env,
    TERMYTE_AGENT: plan.resolvedAgentName,
    TERMYTE_DB_PATH: readiness.dbPath,
    TERMYTE_RUN: "1",
    TERMYTE_SESSION_ID: readiness.sessionId,
    TERMYTE_WORKSPACE: readiness.repoRoot,
  };

  return await new Promise<number>((resolve) => {
    const child = spawn(plan.resolvedExecutable, plan.agentArgs, {
      cwd: readiness.repoRoot,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", (error) => {
      process.stderr.write(`Termyte could not start the agent launcher: ${plan.agentName}\n${errorMessage(error)}\n`);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      if (signal) {
        process.stderr.write(`Termyte agent launcher exited on signal ${signal}.\n`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
