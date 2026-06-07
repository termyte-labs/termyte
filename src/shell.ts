import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDatabase } from "./db.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { inspectAction } from "./runtime.js";
import { redactEnvKeys } from "./redact.js";
import type { Decision, ExecutionOutcome, InspectionReport, ParsedAction, ResolvedTargets, RiskResult, MemoryMatch } from "./types.js";

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
  shimManifestPath: string;
  runtimeMetadata?: GovernedRuntimeMetadata;
}

export interface GuardResponse {
  sessionId: string;
  decision: Decision;
  reason: string;
  semanticId: string;
  redactedCommand: string;
  rawCommand: string;
  ledgerId?: number;
}

export type GovernedLaunchVia = "termyte-shell" | "termyte-run";

export interface GovernedRuntimeMetadata {
  launchedVia: GovernedLaunchVia;
  runtimeProfile: string;
  agentName?: string;
  agentCommand?: string;
  agentArgs?: string[];
  enabledShims: string[];
  disabledShims: string[];
  shellHooksEnabled: boolean;
  shellHookStrategy: string;
  knownCompatibilityNotes: string[];
  warnings: string[];
}

export interface GovernedSessionOptions {
  sessionId?: string;
  shimTools?: string[];
  runtimeMetadata?: GovernedRuntimeMetadata;
}

export const HIGH_VALUE_SHIMS = ["git", "npm", "pnpm", "yarn", "npx", "node", "python", "pip", "docker"];
export const SHELL_HOST_SHIMS = ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"];
export const DEFAULT_SHIM_TOOLS = [...HIGH_VALUE_SHIMS, ...SHELL_HOST_SHIMS];
const GOVERNED_SHELLS = new Set(["bash", "zsh", "pwsh", "powershell"]);
const STALE_SHIM_PENDING_MS = 60_000;
const SHELL_SHIM_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_SHIM_EXECUTION_TIMEOUT_MS = 30 * 60_000;

interface ShimManifestEntry {
  name: string;
  path: string;
  sha256: string;
  size: number;
  createdAt: string;
  platform: NodeJS.Platform;
}

interface ShimManifest {
  sessionId: string;
  shimDir: string;
  createdAt: string;
  platform: NodeJS.Platform;
  entries: ShimManifestEntry[];
}

interface PendingShimExecution {
  action: ParsedAction;
  targets: ResolvedTargets;
  risk: RiskResult;
  memoryMatches: MemoryMatch[];
  finalDecision: Decision;
  finalReason: string;
  cwd: string;
}

interface GuardDecisionRequest {
  type?: "decide";
  sessionId?: string;
  command?: string;
  cwd?: string;
  tool?: string;
  argv?: string[];
  commandCorrelationId?: string;
}

interface GuardFinalizeRequest {
  type: "finalize";
  sessionId?: string;
  ledgerId?: number;
  outcome?: ExecutionOutcome;
  executablePath?: string | null;
  argv?: string[];
  tool?: string;
  sessionIdForMetadata?: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  signal?: string | null;
  errorMessage?: string;
  commandCorrelationId?: string;
}

interface GuardHeartbeatRequest {
  type: "heartbeat";
  sessionId?: string;
  ledgerId?: number;
  pid?: number;
  lastHeartbeatAt?: string;
  heartbeatIntervalMs?: number;
}

interface GuardHookRequest {
  type: "hook";
  sessionId?: string;
  commandLine?: string;
  cwd?: string;
  shell?: string;
  commandCorrelationId?: string;
}

export function createGovernedSession(workspaceRoot: string, options: GovernedSessionOptions = {}): GovernedSession {
  const root = path.resolve(workspaceRoot);
  const sessionId = options.sessionId ?? crypto.randomUUID();
  const sessionDir = path.join(root, ".termyte", "sessions", sessionId);
  const shimDir = path.join(sessionDir, "shims");
  const dbPath = defaultDbPath(root);
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const nodePath = process.execPath;
  const originalPath = originalExecutablePath(process.env);
  const shimManifestPath = path.join(sessionDir, "shim-manifest.json");
  const socketPath =
      process.platform === "win32"
      ? `\\\\.\\pipe\\termyte-${sessionId}`
      : path.join(os.tmpdir(), `termyte-${sessionId}.sock`);

  fs.mkdirSync(shimDir, { recursive: true });
  hardenSessionDirectories(sessionDir, shimDir);
  const session = {
    sessionId,
    workspaceRoot: root,
    sessionDir,
    shimDir,
    socketPath,
    dbPath,
    cliPath,
    nodePath,
    originalPath,
    shimManifestPath,
    runtimeMetadata: options.runtimeMetadata,
  };
  writeSessionShims(session, options.shimTools ?? DEFAULT_SHIM_TOOLS);
  return session;
}

export function buildSessionEnv(session: GovernedSession): NodeJS.ProcessEnv {
  const pathKey = process.platform === "win32" ? pathEnvKey(process.env) : "PATH";
  const shimmedPath = [session.shimDir, session.originalPath].filter(Boolean).join(path.delimiter);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TERMYTE_RUN: "1",
    TERMYTE_SESSION_ID: session.sessionId,
    TERMYTE_AGENT: session.runtimeMetadata?.agentName,
    TERMYTE_GUARD_SOCKET: session.socketPath,
    TERMYTE_SHIM_DIR: session.shimDir,
    TERMYTE_ORIGINAL_PATH: session.originalPath,
    TERMYTE_DB_PATH: session.dbPath,
    TERMYTE_WORKSPACE: session.workspaceRoot,
    TERMYTE_WORKSPACE_ROOT: session.workspaceRoot,
    TERMYTE_CLI_PATH: session.cliPath,
    TERMYTE_NODE: session.nodePath,
    TERMYTE_SHIM_MANIFEST: session.shimManifestPath,
    ZDOTDIR: session.sessionDir,
  };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") {
      delete env[key];
    }
  }
  env[pathKey] = shimmedPath;
  return env;
}

function pathEnvKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function currentPathValue(env: NodeJS.ProcessEnv): string {
  return env[pathEnvKey(env)] ?? env.PATH ?? "";
}

function originalExecutablePath(env: NodeJS.ProcessEnv): string {
  return stripTermyteShimPathEntries(env.TERMYTE_ORIGINAL_PATH ?? currentPathValue(env));
}

function stripTermyteShimPathEntries(value: string, currentShimDir?: string): string {
  return value
    .split(path.delimiter)
    .filter(Boolean)
    .filter((entry) => !isTermyteShimPath(entry, currentShimDir))
    .join(path.delimiter);
}

function isTermyteShimPath(entry: string, currentShimDir?: string): boolean {
  const resolved = path.resolve(entry);
  if (currentShimDir && resolved === path.resolve(currentShimDir)) {
    return true;
  }

  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)\.termyte\/(?:sessions\/[^/]+|preview)\/shims$/.test(normalized);
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
  writeShimManifest(session, tools);
}

export function writeShimManifest(session: GovernedSession, tools: string[]): ShimManifest {
  const createdAt = new Date().toISOString();
  const entries = tools.map((tool) => {
    const shimPath = expectedShimPath(session, tool);
    const stat = fs.statSync(shimPath);
    return {
      name: tool,
      path: shimPath,
      sha256: sha256File(shimPath),
      size: stat.size,
      createdAt,
      platform: process.platform,
    };
  });
  const manifest = {
    sessionId: session.sessionId,
    shimDir: session.shimDir,
    createdAt,
    platform: process.platform,
    entries,
  };
  fs.writeFileSync(session.shimManifestPath, JSON.stringify(manifest, null, 2), "utf8");
  if (process.platform !== "win32") {
    fs.chmodSync(session.shimManifestPath, 0o600);
  }
  return manifest;
}

export function verifyShimManifest(session: GovernedSession, tool?: string): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!fs.existsSync(session.shimManifestPath)) {
    return { ok: false, reasons: ["shim manifest is missing"] };
  }

  let manifest: ShimManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(session.shimManifestPath, "utf8")) as ShimManifest;
  } catch {
    return { ok: false, reasons: ["shim manifest is unreadable"] };
  }

  if (manifest.sessionId !== session.sessionId) {
    reasons.push("shim manifest session id mismatch");
  }
  if (path.resolve(manifest.shimDir) !== path.resolve(session.shimDir)) {
    reasons.push("shim manifest directory mismatch");
  }

  const manifestPaths = new Set<string>();
  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  for (const entry of entries) {
    const expectedPath = expectedShimPath(session, entry.name);
    const actualPath = path.resolve(entry.path);
    manifestPaths.add(actualPath);
    if (actualPath !== path.resolve(expectedPath)) {
      reasons.push(`shim path mismatch: ${entry.name}`);
      continue;
    }
    if (!fs.existsSync(actualPath)) {
      reasons.push(`shim missing: ${entry.name}`);
      continue;
    }
    const stat = fs.statSync(actualPath);
    const hash = sha256File(actualPath);
    if (stat.size !== entry.size) {
      reasons.push(`shim size mismatch: ${entry.name}`);
    }
    if (hash !== entry.sha256) {
      reasons.push(`shim hash mismatch: ${entry.name}`);
    }
  }

  if (tool && !entries.some((entry) => entry.name === tool && path.resolve(entry.path) === path.resolve(expectedShimPath(session, tool)))) {
    reasons.push(`requested shim is not in manifest: ${tool}`);
  }

  for (const fileName of fs.readdirSync(session.shimDir)) {
    const fullPath = path.resolve(session.shimDir, fileName);
    if (!manifestPaths.has(fullPath) && isShimExecutable(fullPath)) {
      reasons.push(`unexpected executable in shim dir: ${fileName}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function startGuardDaemon(session: GovernedSession): net.Server {
  recoverStaleShimExecutions(session);
  if (!process.platform.startsWith("win")) {
    try {
      fs.rmSync(session.socketPath, { force: true });
    } catch {
      // Ignore stale socket cleanup failures.
    }
  }

  const pending = new Map<number, PendingShimExecution>();
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
          const request = JSON.parse(payload) as GuardDecisionRequest | GuardFinalizeRequest | GuardHeartbeatRequest | GuardHookRequest;
          response = request.type === "finalize"
            ? handleGuardFinalizeRequest(session, request, pending)
            : request.type === "heartbeat"
              ? handleGuardHeartbeatRequest(session, request)
              : request.type === "hook"
                ? handleGuardHookRequest(session, request)
              : handleGuardRequest(session, request, pending);
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

export function recoverStaleShimExecutions(session: GovernedSession, staleMs = STALE_SHIM_PENDING_MS, now = new Date()): number {
  const ledger = new Ledger(openDatabase(session.dbPath).db);
  return ledger.recoverStaleShellShimPending({
    workspaceRoot: session.workspaceRoot,
    activeSessionId: session.sessionId,
    staleMs,
    now,
  });
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
  request: GuardDecisionRequest,
  pending = new Map<number, PendingShimExecution>(),
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

  const manifestCheck = verifyShimManifest(session, request.tool);
  if (!manifestCheck.ok) {
    return recordShimTamper(session, request, manifestCheck.reasons);
  }

  const cwd = path.resolve(request.cwd ?? session.workspaceRoot);
  const dbContext = openDatabase(session.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  const report = inspectAction(request.command, cwd, session.dbPath);
  const action = report.action;
  const targets = report.targets;
  const risk = report.risk;
  const policy = report.policy;
  const memoryMatches = report.memoryMatches;
  const finalDecision = report.finalDecision;
  const finalReason = report.finalReason;
  const ledgerId = ledger.createPending(action, targets, redactEnvKeys(process.env), {
    cwd,
    shell: action.shell,
    targets,
    risk,
    policy,
    memoryMatches,
    finalDecision,
    ...sessionRuntimeMetadataFields(session),
    runtime: "shell-shim",
    shimRuntime: true,
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    guardSocket: session.socketPath,
    tool: request.tool,
    argv: request.argv ?? [],
    commandCorrelationId: request.commandCorrelationId,
    startedAt: new Date().toISOString(),
    lastHeartbeatAt: new Date().toISOString(),
    heartbeatIntervalMs: SHELL_SHIM_HEARTBEAT_INTERVAL_MS,
  });

  if (finalDecision === "block") {
    const outcome = {
      status: "blocked" as const,
      exitCode: 1,
      stdout: "",
      stderr: `${finalReason}\n`,
      durationMs: 0,
    };
    ledger.finalize(ledgerId, finalDecision, outcome, risk.score, finalReason, {
      endedAt: new Date().toISOString(),
      durationMs: 0,
      executedVia: "shell-shim",
    });
    memory.observe(action, finalDecision, outcome, cwd);
  } else {
    pending.set(ledgerId, {
      action,
      targets,
      risk,
      memoryMatches,
      finalDecision,
      finalReason,
      cwd,
    });
  }

  return {
    sessionId: session.sessionId,
    decision: finalDecision,
    reason: finalReason,
    semanticId: action.semanticId,
    redactedCommand: action.redactedCommand,
    rawCommand: action.rawCommand,
    ledgerId,
  };
}

function recordShimTamper(session: GovernedSession, request: GuardDecisionRequest, reasons: string[]): GuardResponse {
  const command = request.command ?? buildGuardCommand(request.tool ?? "unknown", request.argv ?? []);
  const cwd = path.resolve(request.cwd ?? session.workspaceRoot);
  const dbContext = openDatabase(session.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  const report = inspectAction(command, cwd, session.dbPath);
  const action = report.action;
  const targets = report.targets;
  const reason = `shim_tamper_detected: ${reasons.join("; ")}`;
  const ledgerId = ledger.createPending(action, targets, redactEnvKeys(process.env), {
    cwd,
    shell: action.shell,
    targets,
    risk: report.risk,
    policy: report.policy,
    memoryMatches: report.memoryMatches,
    finalDecision: "block",
    ...sessionRuntimeMetadataFields(session),
    runtime: "shell-shim",
    shimRuntime: true,
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    guardSocket: session.socketPath,
    tool: request.tool,
    argv: request.argv ?? [],
    commandCorrelationId: request.commandCorrelationId,
    executionError: "shim_tamper_detected",
    tamperReasons: reasons,
    startedAt: new Date().toISOString(),
  });
  const outcome = {
    status: "failed" as const,
    exitCode: 126,
    stdout: "",
    stderr: `${reason}\n`,
    durationMs: 0,
    errorMessage: "shim_tamper_detected",
  };
  ledger.finalize(ledgerId, "block", outcome, report.risk.score, reason, {
    endedAt: new Date().toISOString(),
    durationMs: 0,
    executionError: "shim_tamper_detected",
    tamperReasons: reasons,
    executedVia: "shell-shim",
    runtime: "shell-shim",
    shimRuntime: true,
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    commandCorrelationId: request.commandCorrelationId,
  });
  memory.observe(action, "block", outcome, cwd);
  return {
    sessionId: session.sessionId,
    decision: "block",
    reason,
    semanticId: action.semanticId,
    redactedCommand: action.redactedCommand,
    rawCommand: action.rawCommand,
    ledgerId,
  };
}

export function handleGuardHeartbeatRequest(
  session: GovernedSession,
  request: GuardHeartbeatRequest,
): GuardResponse {
  if (!request.sessionId || request.sessionId !== session.sessionId) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Invalid or missing Termyte session.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  if (!request.ledgerId) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Missing ledger id for shim heartbeat.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  const ledger = new Ledger(openDatabase(session.dbPath).db);
  const updated = ledger.updateShellShimHeartbeat(request.ledgerId, {
    pid: request.pid,
    sessionId: session.sessionId,
    lastHeartbeatAt: request.lastHeartbeatAt ?? new Date().toISOString(),
    heartbeatIntervalMs: request.heartbeatIntervalMs ?? SHELL_SHIM_HEARTBEAT_INTERVAL_MS,
  });

  return {
    sessionId: session.sessionId,
    decision: updated ? "allow" : "block",
    reason: updated ? "Heartbeat recorded." : `No pending shell-shim execution found for ledger id ${request.ledgerId}.`,
    semanticId: "shell.generic",
    redactedCommand: "",
    rawCommand: "",
    ledgerId: request.ledgerId,
  };
}

export function handleGuardHookRequest(
  session: GovernedSession,
  request: GuardHookRequest,
): GuardResponse {
  if (!request.sessionId || request.sessionId !== session.sessionId) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Invalid or missing Termyte session.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: request.commandLine ?? "",
    };
  }

  if (!request.commandLine) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Missing shell hook command line.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  const cwd = path.resolve(request.cwd ?? session.workspaceRoot);
  const dbContext = openDatabase(session.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  const report = inspectAction(request.commandLine, cwd, session.dbPath);
  const action = report.action;
  const targets = report.targets;
  const risk = report.risk;
  const finalDecision = report.finalDecision;
  const finalReason = report.finalReason;
  const startedAt = new Date().toISOString();
  const commandCorrelationId = request.commandCorrelationId ?? crypto.randomUUID();
  const ledgerId = ledger.createPending(action, targets, redactEnvKeys(process.env), {
    cwd,
    shell: request.shell ?? action.shell,
    commandLine: request.commandLine,
    commandCorrelationId,
    targets,
    risk,
    policy: report.policy,
    memoryMatches: report.memoryMatches,
    finalDecision,
    ...sessionRuntimeMetadataFields(session),
    runtime: "shell-hook",
    hookRuntime: true,
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    startedAt,
  });

  const outcome = {
    status: finalDecision === "block" ? "blocked" as const : "executed" as const,
    exitCode: finalDecision === "block" ? 1 : 0,
    stdout: "",
    stderr: finalDecision === "block" ? `${finalReason}\n` : "",
    durationMs: 0,
  };
  ledger.finalize(ledgerId, finalDecision, outcome, risk.score, finalReason, {
    endedAt: new Date().toISOString(),
    durationMs: 0,
    executedVia: "shell-hook",
    runtime: "shell-hook",
    hookRuntime: true,
    shell: request.shell ?? action.shell,
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    commandLine: request.commandLine,
    commandCorrelationId,
  });
  memory.observe(action, finalDecision, outcome, cwd);

  return {
    sessionId: session.sessionId,
    decision: finalDecision,
    reason: finalReason,
    semanticId: action.semanticId,
    redactedCommand: action.redactedCommand,
    rawCommand: action.rawCommand,
    ledgerId,
  };
}

export function handleGuardFinalizeRequest(
  session: GovernedSession,
  request: GuardFinalizeRequest,
  pending: Map<number, PendingShimExecution>,
): GuardResponse {
  if (!request.sessionId || request.sessionId !== session.sessionId) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Invalid or missing Termyte session.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  if (!request.ledgerId || !request.outcome) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: "Missing ledger id or outcome for shim finalization.",
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  const pendingEntry = pending.get(request.ledgerId);
  if (!pendingEntry) {
    return {
      sessionId: session.sessionId,
      decision: "block",
      reason: `No pending shim execution found for ledger id ${request.ledgerId}.`,
      semanticId: "shell.generic",
      redactedCommand: "",
      rawCommand: "",
    };
  }

  const dbContext = openDatabase(session.dbPath);
  const ledger = new Ledger(dbContext.db);
  const memory = new MemoryEngine(dbContext.db);
  ledger.finalize(request.ledgerId, pendingEntry.finalDecision, request.outcome, pendingEntry.risk.score, pendingEntry.finalReason, {
    endedAt: request.endedAt ?? new Date().toISOString(),
    durationMs: request.durationMs ?? request.outcome.durationMs,
    executablePath: request.executablePath ?? null,
    argv: request.argv ?? [],
    tool: request.tool,
    signal: request.signal ?? null,
    executionError: request.errorMessage ?? request.outcome.errorMessage,
    executedVia: "shell-shim",
    runtime: "shell-shim",
    shimRuntime: true,
    ...sessionRuntimeMetadataFields(session),
    sessionId: session.sessionId,
    workspaceRoot: session.workspaceRoot,
    commandCorrelationId: request.commandCorrelationId,
  });
  memory.observe(pendingEntry.action, pendingEntry.finalDecision, request.outcome, pendingEntry.cwd);
  pending.delete(request.ledgerId);

  return {
    sessionId: session.sessionId,
    decision: pendingEntry.finalDecision,
    reason: pendingEntry.finalReason,
    semanticId: pendingEntry.action.semanticId,
    redactedCommand: pendingEntry.action.redactedCommand,
    rawCommand: pendingEntry.action.rawCommand,
    ledgerId: request.ledgerId,
  };
}

export async function launchGovernedSession(options: {
  workspaceRoot: string;
  sessionId?: string;
  agentArgs?: string[];
  shimTools?: string[];
  shellHooksEnabled?: boolean;
  runtimeMetadata?: GovernedRuntimeMetadata;
}): Promise<number> {
  const session = createGovernedSession(options.workspaceRoot, {
    sessionId: options.sessionId,
    shimTools: options.shimTools,
    runtimeMetadata: options.runtimeMetadata,
  });
  if (session.runtimeMetadata) {
    session.runtimeMetadata = {
      ...session.runtimeMetadata,
      agentArgs: session.runtimeMetadata.agentArgs ?? [],
    };
    for (const warning of session.runtimeMetadata.warnings) {
      process.stderr.write(`Termyte run profile warning: ${warning}\n`);
    }
  }
  if (options.shellHooksEnabled ?? true) {
    writeShellHooks(session);
  }
  const server = startGuardDaemon(session);
  await waitForServerListening(server);
  const env = buildSessionEnv(session);
  const agentArgs = options.agentArgs ?? [];
  const requestedCommand = agentArgs.length > 0 ? agentArgs[0] : detectDefaultShell();
  const explicitArgs = agentArgs.length > 0 ? agentArgs.slice(1) : undefined;
  if (session.runtimeMetadata) {
    session.runtimeMetadata = {
      ...session.runtimeMetadata,
      agentCommand: resolveSessionLaunchCommand(requestedCommand, session, explicitArgs),
      agentArgs: explicitArgs ?? [],
    };
  }
  let launchLedgerId: number | undefined;
  if (session.runtimeMetadata) {
    const launchCommandLine = buildGuardCommand(requestedCommand, explicitArgs ?? []);
    const dbContext = openDatabase(session.dbPath);
    const ledger = new Ledger(dbContext.db);
    const memory = new MemoryEngine(dbContext.db);
    const launchAction = inspectAction(launchCommandLine, session.workspaceRoot, session.dbPath);
    const launchOutcome = {
      status: "executed" as const,
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 0,
    };
    launchLedgerId = ledger.createPending(launchAction.action, launchAction.targets, redactEnvKeys(process.env), {
      cwd: session.workspaceRoot,
      shell: launchAction.action.shell,
      targets: launchAction.targets,
      risk: launchAction.risk,
      policy: launchAction.policy,
      memoryMatches: launchAction.memoryMatches,
      finalDecision: launchAction.finalDecision,
      ...sessionRuntimeMetadataFields(session),
      runtime: "agent-run",
      agentLaunch: true,
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
      commandCorrelationId: process.env.TERMYTE_COMMAND_CORRELATION_ID,
      startedAt: new Date().toISOString(),
    });
    ledger.finalize(launchLedgerId, launchAction.finalDecision, launchOutcome, launchAction.risk.score, launchAction.finalReason, {
      endedAt: new Date().toISOString(),
      durationMs: 0,
      executedVia: "termyte-run",
      runtime: "agent-run",
      agentLaunch: true,
      ...sessionRuntimeMetadataFields(session),
      sessionId: session.sessionId,
      workspaceRoot: session.workspaceRoot,
    });
    memory.observe(launchAction.action, launchAction.finalDecision, launchOutcome, session.workspaceRoot);
  }
  const command = resolveSessionLaunchCommand(requestedCommand, session, explicitArgs);
  const args = shellLaunchArgs(requestedCommand, explicitArgs, session);
  const exitCode = await launchProcess(command, args, env, session.workspaceRoot);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return exitCode;
}

function waitForServerListening(server: net.Server): Promise<void> {
  if (server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

function writeShellHooks(session: GovernedSession): void {
  fs.writeFileSync(path.join(session.sessionDir, "bash-hook.sh"), buildBashHookScript(), "utf8");
  fs.writeFileSync(path.join(session.sessionDir, "zsh-hook.zsh"), buildZshHookScript(), "utf8");
  fs.writeFileSync(path.join(session.sessionDir, ".zshrc"), buildZshHookScript(), "utf8");
  fs.writeFileSync(path.join(session.sessionDir, "powershell-hook.ps1"), buildPowerShellHookScript(), "utf8");
}

function sessionRuntimeMetadataFields(session: GovernedSession): Record<string, unknown> {
  const metadata = session.runtimeMetadata;
  if (!metadata) {
    return {};
  }

  return {
    launchedVia: metadata.launchedVia,
    agentName: metadata.agentName,
    agentCommand: metadata.agentCommand,
    agentArgs: metadata.agentArgs ?? [],
    runtimeProfile: metadata.runtimeProfile,
    enabledShims: metadata.enabledShims,
    disabledShims: metadata.disabledShims,
    shellHooksEnabled: metadata.shellHooksEnabled,
    shellHookStrategy: metadata.shellHookStrategy,
    knownCompatibilityNotes: metadata.knownCompatibilityNotes,
    runtimeWarnings: metadata.warnings,
  };
}

export function buildBashHookScript(): string {
  return `
__termyte_preexec() {
  [ -n "\${TERMYTE_HOOK_ACTIVE:-}" ] && return 0
  export TERMYTE_HOOK_ACTIVE=1
  local __termyte_command="$BASH_COMMAND"
  case "$__termyte_command" in
    __termyte_preexec*|trap*|shopt*|return*) unset TERMYTE_HOOK_ACTIVE; return 0 ;;
  esac
  export TERMYTE_COMMAND_CORRELATION_ID="hook-$(date +%s%N)-$RANDOM"
  TERMYTE_HOOK_ACTIVE=1 "\${TERMYTE_NODE:-node}" "\${TERMYTE_CLI_PATH}" _hook bash "$__termyte_command"
  local __termyte_status=$?
  unset TERMYTE_HOOK_ACTIVE
  if [ $__termyte_status -ne 0 ]; then
    unset TERMYTE_COMMAND_CORRELATION_ID
    echo "Termyte blocked shell command before dispatch." >&2
    return 1
  fi
}
shopt -s extdebug
trap '__termyte_preexec' DEBUG
`;
}

export function buildZshHookScript(): string {
  return `
TRAPDEBUG() {
  [ -n "\${TERMYTE_HOOK_ACTIVE:-}" ] && return 0
  export TERMYTE_HOOK_ACTIVE=1
  local __termyte_command="$ZSH_DEBUG_CMD"
  case "$__termyte_command" in
    TRAPDEBUG*|precmd*|preexec*) unset TERMYTE_HOOK_ACTIVE; return 0 ;;
  esac
  export TERMYTE_COMMAND_CORRELATION_ID="hook-$(date +%s%N)-$RANDOM"
  TERMYTE_HOOK_ACTIVE=1 "\${TERMYTE_NODE:-node}" "\${TERMYTE_CLI_PATH}" _hook zsh "$__termyte_command"
  local __termyte_status=$?
  unset TERMYTE_HOOK_ACTIVE
  if [ $__termyte_status -ne 0 ]; then
    unset TERMYTE_COMMAND_CORRELATION_ID
    print -u2 "Termyte blocked shell command before dispatch."
    return 1
  fi
}
`;
}

export function buildPowerShellHookScript(): string {
  return `
if (Get-Command Set-PSReadLineOption -ErrorAction SilentlyContinue) {
  Set-PSReadLineOption -CommandValidationHandler {
    param([System.Management.Automation.Language.CommandAst] $CommandAst)
    $commandLine = $CommandAst.Extent.Text
    $env:TERMYTE_COMMAND_CORRELATION_ID = [guid]::NewGuid().ToString()
    & $env:TERMYTE_NODE $env:TERMYTE_CLI_PATH _hook powershell $commandLine
    if ($LASTEXITCODE -ne 0) {
      Remove-Item Env:\\TERMYTE_COMMAND_CORRELATION_ID -ErrorAction SilentlyContinue
      throw "Termyte blocked shell command before dispatch."
    }
  }
}
`;
}

export function shellLaunchArgs(command: string, explicitArgs: string[] | undefined, session: GovernedSession): string[] {
  const normalized = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/i, "");
  if (normalized === "codex" || normalized === "claude") {
    return explicitArgs ?? [];
  }

  if (GOVERNED_SHELLS.has(normalized)) {
    return injectHookArgs(normalized, explicitArgs ?? defaultShellArgs(), session);
  }

  if (explicitArgs !== undefined) {
    return explicitArgs;
  }

  return [];
}

function injectHookArgs(shellName: string, args: string[], session: GovernedSession): string[] {
  if (shellName === "bash") {
    return ["--rcfile", path.join(session.sessionDir, "bash-hook.sh"), ...args.filter((arg) => arg !== "-i"), "-i"];
  }
  if (shellName === "zsh") {
    return [...args.filter((arg) => arg !== "-i"), "-i"];
  }
  if (shellName === "pwsh" || shellName === "powershell") {
    return ["-NoLogo", "-NoExit", "-File", path.join(session.sessionDir, "powershell-hook.ps1")];
  }
  return args;
}

export function resolveSessionLaunchCommand(
  command: string,
  session: GovernedSession,
  explicitArgs?: string[],
  options: { platform?: NodeJS.Platform; pathext?: string } = {},
): string {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes("/")) {
    return command;
  }

  const platform = options.platform ?? process.platform;
  const normalized = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, "");
  const hasExtension = path.extname(command) !== "";
  if (explicitArgs && explicitArgs.length > 0 && ["sh", "bash", "zsh", "pwsh", "powershell", "cmd"].includes(normalized)) {
    return resolveRealExecutable(command, session.originalPath, session.shimDir, platform, options.pathext) ?? command;
  }

  if (!hasExtension && DEFAULT_SHIM_TOOLS.includes(normalized)) {
    return platform === "win32" ? path.join(session.shimDir, `${normalized}.cmd`) : path.join(session.shimDir, normalized);
  }

  if (platform === "win32") {
    return resolveRealExecutable(command, session.originalPath, session.shimDir, platform, options.pathext) ?? command;
  }

  return command;
}

function expectedShimPath(session: GovernedSession, tool: string): string {
  return process.platform === "win32" ? path.join(session.shimDir, `${tool}.cmd`) : path.join(session.shimDir, tool);
}

function hardenSessionDirectories(sessionDir: string, shimDir: string): void {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(sessionDir, 0o700);
  fs.chmodSync(shimDir, 0o700);
}

function sha256File(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function isShimExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") {
      const ext = path.extname(filePath).toLowerCase();
      return [".cmd", ".bat", ".exe", ".com", ".ps1"].includes(ext);
    }
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function interceptShim(tool: string, argv: string[]): Promise<number> {
  const sessionId = process.env.TERMYTE_SESSION_ID;
  const socketPath = process.env.TERMYTE_GUARD_SOCKET;
  const cwd = process.cwd();
  const originalPath = stripTermyteShimPathEntries(process.env.TERMYTE_ORIGINAL_PATH ?? process.env.PATH ?? "", process.env.TERMYTE_SHIM_DIR);
  const shimDir = process.env.TERMYTE_SHIM_DIR ?? "";
  const cliPath = process.env.TERMYTE_CLI_PATH ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.js");
  const nodePath = process.env.TERMYTE_NODE ?? process.execPath;

  if (!sessionId || !socketPath) {
    console.error("Termyte shim requires an active governed session.");
    return 126;
  }

  const command = buildGuardCommand(tool, argv);
  const commandCorrelationId = process.env.TERMYTE_COMMAND_CORRELATION_ID;
  const localShimSession = sessionFromShimEnv(sessionId, socketPath, cwd, shimDir, originalPath, cliPath, nodePath);
  const localManifestCheck = verifyShimManifest(localShimSession, tool);
  if (!localManifestCheck.ok) {
    process.stderr.write(`Termyte shim integrity check failed; asking guard to record tamper event. ${localManifestCheck.reasons.join("; ")}\n`);
  }
  let response: GuardResponse;
  try {
    response = await requestGuard(socketPath, { sessionId, command, cwd, tool, argv, commandCorrelationId });
  } catch (error) {
    process.stderr.write(`Termyte guard unavailable; blocking shim execution. ${error instanceof Error ? error.message : String(error)}\n`);
    return 126;
  }

  if (response.decision === "block") {
    process.stderr.write(`${response.reason}\n`);
    return 1;
  }

  const realExecutable = resolveRealExecutable(tool, originalPath, shimDir);
  if (!realExecutable) {
    const message = `Termyte could not resolve the real executable for ${tool}.`;
    process.stderr.write(`${message}\n`);
    if (response.ledgerId) {
      await finalizeShimExecution(socketPath, {
        sessionId,
        ledgerId: response.ledgerId,
        outcome: {
          status: "failed",
          exitCode: 127,
          stdout: "",
          stderr: `${message}\n`,
          durationMs: 0,
          errorMessage: message,
        },
        executablePath: null,
        argv,
        tool,
        errorMessage: message,
        commandCorrelationId,
      });
    }
    return 127;
  }

  if (response.decision === "warn") {
    const approved = await promptForApproval(response.reason);
    if (!approved) {
      process.stderr.write(`${response.reason}\n`);
      if (response.ledgerId) {
        await finalizeShimExecution(socketPath, {
          sessionId,
          ledgerId: response.ledgerId,
          outcome: {
            status: "blocked",
            exitCode: 1,
            stdout: "",
            stderr: `${response.reason}\n`,
            durationMs: 0,
          },
          executablePath: realExecutable,
          argv,
          tool,
          commandCorrelationId,
        });
      }
      return 1;
    }
  }

  const startedAt = new Date().toISOString();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  const startHeartbeat = (child: ChildProcess): void => {
    if (!response.ledgerId || !child.pid) return;
    const send = (): void => {
      void sendShimHeartbeat(socketPath, {
        sessionId,
        ledgerId: response.ledgerId ?? 0,
        pid: child.pid,
        lastHeartbeatAt: new Date().toISOString(),
        heartbeatIntervalMs: SHELL_SHIM_HEARTBEAT_INTERVAL_MS,
      }).catch(() => {
        // A finalization failure is reported separately. Heartbeats are best-effort liveness metadata.
      });
    };
    send();
    heartbeatTimer = setInterval(send, SHELL_SHIM_HEARTBEAT_INTERVAL_MS);
  };

  const outcome = await runResolvedExecutable(realExecutable, argv, cwd, nodePath, startHeartbeat);
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  const endedAt = new Date().toISOString();
  if (response.ledgerId) {
    await finalizeShimExecution(socketPath, {
      sessionId,
      ledgerId: response.ledgerId,
      outcome,
      executablePath: realExecutable,
      argv,
      tool,
      startedAt,
      endedAt,
      durationMs: outcome.durationMs,
      signal: outcome.signal ?? null,
      errorMessage: outcome.errorMessage,
      commandCorrelationId,
    });
  }
  return outcome.exitCode ?? 1;
}

function sessionFromShimEnv(
  sessionId: string,
  socketPath: string,
  cwd: string,
  shimDir: string,
  originalPath: string,
  cliPath: string,
  nodePath: string,
): GovernedSession {
  const sessionDir = path.dirname(shimDir);
  return {
    sessionId,
    workspaceRoot: process.env.TERMYTE_WORKSPACE_ROOT ?? cwd,
    sessionDir,
    shimDir,
    socketPath,
    dbPath: process.env.TERMYTE_DB_PATH ?? defaultDbPath(cwd),
    cliPath,
    nodePath,
    originalPath,
    shimManifestPath: process.env.TERMYTE_SHIM_MANIFEST ?? path.join(sessionDir, "shim-manifest.json"),
  };
}

export async function interceptHook(shell: string, commandLine: string): Promise<number> {
  const sessionId = process.env.TERMYTE_SESSION_ID;
  const socketPath = process.env.TERMYTE_GUARD_SOCKET;
  const cwd = process.cwd();
  const commandCorrelationId = process.env.TERMYTE_COMMAND_CORRELATION_ID;

  if (!sessionId || !socketPath) {
    process.stderr.write("Termyte guard unavailable; blocking shell hook execution.\n");
    return 126;
  }

  try {
    const response = await requestGuard(socketPath, {
      type: "hook",
      sessionId,
      commandLine,
      cwd,
      shell,
      commandCorrelationId,
    });
    if (response.decision === "block") {
      process.stderr.write(`${response.reason}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`Termyte guard unavailable; blocking shell hook execution. ${error instanceof Error ? error.message : String(error)}\n`);
    return 126;
  }
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
    const useWindowsShell = isWindowsCommandScript(command);
    const child = spawn(useWindowsShell ? buildCmdCommand(command, args) : command, useWindowsShell ? [] : args, {
      cwd,
      env,
      stdio: "inherit",
      shell: useWindowsShell,
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

async function requestGuard(socketPath: string, request: Record<string, unknown>): Promise<GuardResponse> {
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

async function finalizeShimExecution(
  socketPath: string,
  request: Omit<GuardFinalizeRequest, "type"> & { sessionId: string; ledgerId: number },
): Promise<GuardResponse> {
  try {
    return await requestGuard(socketPath, { ...request, type: "finalize" });
  } catch (error) {
    process.stderr.write(`Termyte guard finalization failed: ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}

async function sendShimHeartbeat(
  socketPath: string,
  request: Omit<GuardHeartbeatRequest, "type"> & { sessionId: string; ledgerId: number },
): Promise<GuardResponse> {
  return await requestGuard(socketPath, { ...request, type: "heartbeat" });
}

export function resolveRealExecutable(
  tool: string,
  originalPath: string,
  shimDir: string,
  platform: NodeJS.Platform = process.platform,
  pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
): string | null {
  const searchPaths = originalPath.split(path.delimiter).filter(Boolean).filter((entry) => !isTermyteShimPath(entry, shimDir));
  const candidates = resolveExecutableCandidates(tool, platform, pathext);

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

function resolveExecutableCandidates(
  tool: string,
  platform: NodeJS.Platform = process.platform,
  pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
): string[] {
  if (platform === "win32") {
    const extensions = pathext.split(";").filter(Boolean);
    const toolLower = tool.toLowerCase();
    if (path.extname(toolLower)) {
      return [tool];
    }
    return extensions.map((ext) => `${tool}${ext.toLowerCase()}`);
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

export function runResolvedExecutable(
  resolved: string,
  argv: string[],
  cwd: string,
  nodePath: string,
  onProcessStarted?: (child: ChildProcess) => void,
  timeoutMs = shimExecutionTimeoutMs(process.env),
): Promise<ExecutionOutcome & { signal?: string | null }> {
  const useWindowsShell = isWindowsCommandScript(resolved);
  const command = useWindowsShell ? buildCmdCommand(resolved, argv) : resolved;
  const args = useWindowsShell ? [] : argv;

  const started = Date.now();
  return new Promise<ExecutionOutcome & { signal?: string | null }>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: ExecutionOutcome & { signal?: string | null }): void => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(outcome);
    };
    const env = {
      ...process.env,
      TERMYTE_NODE: nodePath,
      TERMYTE_ORIGINAL_PATH: stripTermyteShimPathEntries(process.env.TERMYTE_ORIGINAL_PATH ?? process.env.PATH ?? "", process.env.TERMYTE_SHIM_DIR),
    };

    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env,
      shell: useWindowsShell,
    });
    onProcessStarted?.(child);
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        const message = `Termyte shim execution timed out after ${timeoutMs}ms.`;
        child.kill();
        finish({
          status: "failed",
          exitCode: null,
          stdout: "",
          stderr: `${message}\n`,
          durationMs: Date.now() - started,
          errorMessage: "shell_shim_execution_timeout",
          signal: null,
        });
      }, timeoutMs);
    }

    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      finish({
        status: "failed",
        exitCode: null,
        stdout: "",
        stderr: `${error instanceof Error ? error.message : String(error)}\n`,
        durationMs: Date.now() - started,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        finish({
          status: "failed",
          exitCode: code,
          stdout: "",
          stderr: `Process terminated by signal ${signal}.\n`,
          durationMs: Date.now() - started,
          errorMessage: `Process terminated by signal ${signal}.`,
          signal,
        });
        return;
      }
      finish({
        status: code === 0 ? "executed" : "failed",
        exitCode: code ?? 0,
        stdout: "",
        stderr: "",
        durationMs: Date.now() - started,
        signal: null,
      });
    });
  });
}

function shimExecutionTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env.TERMYTE_SHIM_EXECUTION_TIMEOUT_MS;
  if (!raw) {
    return DEFAULT_SHIM_EXECUTION_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_SHIM_EXECUTION_TIMEOUT_MS;
}

function isWindowsCommandScript(value: string): boolean {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(value);
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
