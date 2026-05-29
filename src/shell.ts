import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultDbPath } from "./db.js";
import { inspectAction } from "./runtime.js";
import type { Decision, InspectionReport } from "./types.js";

export interface GovernedSession {
  sessionId: string;
  workspaceRoot: string;
  sessionDir: string;
  shimDir: string;
  socketPath: string;
  dbPath: string;
  cliPath: string;
  nodePath: string;
  originalPath: string;
}

export interface GuardResponse {
  sessionId: string;
  decision: Decision;
  reason: string;
  semanticId: string;
  redactedCommand: string;
  rawCommand: string;
}

export function createGovernedSession(workspaceRoot: string): GovernedSession {
  const root = path.resolve(workspaceRoot);
  const sessionId = crypto.randomUUID();
  const sessionDir = path.join(root, ".termyte", "sessions", sessionId);
  const shimDir = path.join(sessionDir, "shims");
  const dbPath = defaultDbPath(root);
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const nodePath = process.execPath;
  const originalPath = process.env.PATH ?? "";
  const socketPath =
      process.platform === "win32"
      ? `\\\\.\\pipe\\termyte-${sessionId}`
      : path.join(os.tmpdir(), `termyte-${sessionId}.sock`);

  fs.mkdirSync(shimDir, { recursive: true });
  return { sessionId, workspaceRoot: root, sessionDir, shimDir, socketPath, dbPath, cliPath, nodePath, originalPath };
}

export function buildSessionEnv(session: GovernedSession): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [session.shimDir, session.originalPath].filter(Boolean).join(path.delimiter),
    TERMYTE_SESSION_ID: session.sessionId,
    TERMYTE_GUARD_SOCKET: session.socketPath,
    TERMYTE_SHIM_DIR: session.shimDir,
    TERMYTE_ORIGINAL_PATH: session.originalPath,
    TERMYTE_DB_PATH: session.dbPath,
    TERMYTE_WORKSPACE_ROOT: session.workspaceRoot,
    TERMYTE_CLI_PATH: session.cliPath,
    TERMYTE_NODE: session.nodePath,
  };
}

export function buildGuardCommand(tool: string, argv: string[]): string {
  return [tool, ...argv.map((arg) => quoteForInspection(arg))].join(" ").trim();
}

export function buildUnixShimScript(tool: string): string {
  return `#!/usr/bin/env sh
set -eu

if [ -z "\${TERMYTE_CLI_PATH:-}" ] || [ -z "\${TERMYTE_GUARD_SOCKET:-}" ] || [ -z "\${TERMYTE_SESSION_ID:-}" ]; then
  echo "Termyte shim requires an active governed session." >&2
  exit 126
fi

exec "\${TERMYTE_NODE:-node}" "\${TERMYTE_CLI_PATH}" _shim ${JSON.stringify(tool)} "$@"
`;
}

export function buildWindowsShimScript(tool: string): string {
  return `@echo off
setlocal

if "%TERMYTE_CLI_PATH%"=="" (
  echo Termyte shim requires an active governed session. 1>&2
  exit /b 126
)

if "%TERMYTE_GUARD_SOCKET%"=="" (
  echo Termyte shim requires an active governed session. 1>&2
  exit /b 126
)

if "%TERMYTE_SESSION_ID%"=="" (
  echo Termyte shim requires an active governed session. 1>&2
  exit /b 126
)

"%TERMYTE_NODE%" "%TERMYTE_CLI_PATH%" _shim ${tool} %*
exit /b %errorlevel%
`;
}

export function writeSessionShims(session: GovernedSession, tools: string[]): void {
  for (const tool of tools) {
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(session.shimDir, `${tool}.cmd`), buildWindowsShimScript(tool), "utf8");
    } else {
      const shimPath = path.join(session.shimDir, tool);
      fs.writeFileSync(shimPath, buildUnixShimScript(tool), "utf8");
      fs.chmodSync(shimPath, 0o755);
    }
  }
}

export function startGuardDaemon(session: GovernedSession): net.Server {
  if (!process.platform.startsWith("win")) {
    try {
      fs.rmSync(session.socketPath, { force: true });
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const payload = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!payload) continue;

        let response: GuardResponse;
        try {
          const request = JSON.parse(payload) as { sessionId?: string; command?: string; cwd?: string };
          response = handleGuardRequest(session, request);
        } catch (error) {
          response = {
            sessionId: session.sessionId,
            decision: "block",
            reason: error instanceof Error ? error.message : String(error),
            semanticId: "shell.generic",
            redactedCommand: "",
            rawCommand: "",
          };
        }

        socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });

  server.on("close", () => {
    if (!process.platform.startsWith("win")) {
      try {
        fs.rmSync(session.socketPath, { force: true });
      } catch {
        // Ignore stale socket cleanup failures.
      }
    }
  });

  server.listen(session.socketPath);
  return server;
}

export async function shellInspectRequest(
  session: GovernedSession,
  command: string,
  cwd: string,
): Promise<InspectionReport> {
  return inspectAction(command, cwd, session.dbPath);
}

export function handleGuardRequest(
  session: GovernedSession,
  request: { sessionId?: string; command?: string; cwd?: string },
): GuardResponse {
  if (!request.sessionId || request.sessionId !== session.sessionId) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Invalid or missing Termyte session.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: request.command ?? "",
    };
  }

  if (!request.command) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Missing command.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  const report = inspectAction(request.command, request.cwd ?? session.workspaceRoot, session.dbPath);
  return {
    sessionId: session.sessionId,
    decision: report.finalDecision,
    reason: report.finalReason,
    semanticId: report.action.semanticId,
    redactedCommand: report.action.redactedCommand,
    rawCommand: report.action.rawCommand,
  };
}

export async function launchGovernedSession(options: {
  workspaceRoot: string;
  agentArgs?: string[];
}): Promise<number> {
  const session = createGovernedSession(options.workspaceRoot);
  writeSessionShims(session, ["git", "npm", "pnpm", "yarn", "npx", "sh", "bash", "zsh", "pwsh", "powershell", "cmd", "python", "pip", "docker"]);
  const server = startGuardDaemon(session);
  const env = buildSessionEnv(session);
  const agentArgs = options.agentArgs ?? [];
  const command = agentArgs.length > 0 ? agentArgs[0] : detectDefaultShell();
  const args = agentArgs.length > 0 ? agentArgs.slice(1) : defaultShellArgs();
  const exitCode = await launchProcess(command, args, env, session.workspaceRoot);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return exitCode;
}

export async function interceptShim(tool: string, argv: string[]): Promise<number> {
  const sessionId = process.env.TERMYTE_SESSION_ID;
  const socketPath = process.env.TERMYTE_GUARD_SOCKET;
  const cwd = process.cwd();
  const originalPath = process.env.TERMYTE_ORIGINAL_PATH ?? process.env.PATH ?? "";
  const shimDir = process.env.TERMYTE_SHIM_DIR ?? "";
  const cliPath = process.env.TERMYTE_CLI_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const nodePath = process.env.TERMYTE_NODE ?? process.execPath;

  if (!sessionId || !socketPath) {
    console.error("Termyte shim requires an active governed session.");
    return 126;
  }

  const command = buildGuardCommand(tool, argv);
  const response = await requestGuard(socketPath, { sessionId, command, cwd });

  if (response.decision === "block") {
    process.stderr.write(`${response.reason}\n`);
    return 1;
  }

  const realExecutable = resolveRealExecutable(tool, originalPath, shimDir);
  if (!realExecutable) {
    process.stderr.write(`Termyte could not resolve the real executable for ${tool}.\n`);
    return 127;
  }

  if (response.decision === "warn") {
    const approved = await promptForApproval(response.reason);
    if (!approved) {
      process.stderr.write(`${response.reason}\n`);
      return 1;
    }
  }

  return runResolvedExecutable(realExecutable, argv, cwd, nodePath);
}

function detectDefaultShell(): string {
  if (process.platform === "win32") {
    return resolveFirstAvailable(["pwsh", "powershell", "cmd"]) ?? "cmd";
  }
  return process.env.SHELL ?? resolveFirstAvailable(["bash", "zsh", "sh"]) ?? "sh";
}

function defaultShellArgs(): string[] {
  if (process.platform === "win32") {
    if (resolveFirstAvailable(["pwsh"])) {
      return ["-NoLogo", "-NoExit"];
    }
    if (resolveFirstAvailable(["powershell"])) {
      return ["-NoLogo", "-NoExit"];
    }
    return [];
  }

  return ["-i"];
}

async function launchProcess(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  return await new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell: false,
    });

    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

async function requestGuard(socketPath: string, request: { sessionId: string; command: string; cwd: string }): Promise<GuardResponse> {
  return await new Promise<GuardResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const payload = buffer.slice(0, newline).trim();
      if (!payload) {
        reject(new Error("Termyte guard returned an empty response."));
        socket.destroy();
        return;
      }
      try {
        resolve(JSON.parse(payload) as GuardResponse);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        socket.end();
      }
    });
    socket.on("error", (error) => reject(error));
  });
}

export function resolveRealExecutable(tool: string, originalPath: string, shimDir: string): string | null {
  const searchPaths = originalPath.split(path.delimiter).filter(Boolean).filter((entry) => path.resolve(entry) !== path.resolve(shimDir));
  const candidates = resolveExecutableCandidates(tool);

  for (const dir of searchPaths) {
    for (const candidate of candidates) {
      const fullPath = path.join(dir, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

function resolveExecutableCandidates(tool: string): string[] {
  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    const toolLower = tool.toLowerCase();
    if (path.extname(toolLower)) {
      return [tool];
    }
    return pathext.map((ext) => `${tool}${ext.toLowerCase()}`);
  }

  return [tool];
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") {
      return true;
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quoteForInspection(value: string): string {
  if (value.length === 0) return '""';
  if (/[\s"'`$&|<>()[\]{};]/.test(value)) {
    return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
  }
  return value;
}

async function promptForApproval(reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = await import("node:readline/promises").then((mod) => mod.createInterface({ input: process.stdin, output: process.stdout }));
  const answer = (await rl.question(`\n${reason}\nApprove? [y/N] `)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

function runResolvedExecutable(resolved: string, argv: string[], cwd: string, nodePath: string): Promise<number> {
  const useWindowsShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
  const command = useWindowsShell ? "cmd.exe" : resolved;
  const args = useWindowsShell ? ["/d", "/s", "/c", buildCmdCommand(resolved, argv)] : argv;

  return new Promise<number>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      shell: false,
      env: {
        ...process.env,
        TERMYTE_NODE: nodePath,
      },
    });

    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function buildCmdCommand(executable: string, argv: string[]): string {
  return [quoteCmdArg(executable), ...argv.map((arg) => quoteCmdArg(arg))].join(" ");
}

function quoteCmdArg(value: string): string {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"&|<>^]/.test(value)) {
    return value;
  }

  return `"${value.replace(/(["^])/g, "^$1")}"`;
}

function resolveFirstAvailable(commands: string[]): string | null {
  for (const command of commands) {
    const resolved = which(command);
    if (resolved) return resolved;
  }
  return null;
}

function which(command: string): string | null {
  const candidates = resolveExecutableCandidates(command);
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    for (const candidate of candidates) {
      const fullPath = path.join(entry, candidate);
      if (isExecutable(fullPath)) {
        return fullPath;
      }
    }
  }
  return null;
}
