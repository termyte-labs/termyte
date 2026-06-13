import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { defaultDbPath, openDatabase } from "./db.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { redactEnvKeys } from "./redact.js";
import type { Decision, ExecutionOutcome } from "./types.js";
import { normalizeHookAction, type HookAgent, type HookPhase } from "./action-model.js";
import { evaluateAction, evaluationDecisionForHook, shouldBlockMcpTool } from "./evaluator.js";

export type NativeHookAgent = HookAgent;
export type NativeHookPhase = HookPhase;

export interface NativeHookInvocation {
  agent: NativeHookAgent;
  phase: NativeHookPhase;
  input: string;
  cwd?: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface NativeHookResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: Decision;
  ledgerId?: number;
  command: string;
  reason: string;
}

export interface AgentInstallResult {
  agent: NativeHookAgent;
  path: string;
  installed: boolean;
  active: boolean;
  backupPath?: string;
  changes: string[];
  message: string;
}

export interface AgentUninstallResult {
  agent: NativeHookAgent;
  path: string;
  removed: boolean;
  message: string;
}

export interface AgentHookVerification {
  agent: NativeHookAgent;
  ok: boolean;
  path: string;
  reasons: string[];
}

export interface HookSmokeCheck {
  id: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
}

export interface HookSmokeResult {
  agent: NativeHookAgent;
  ok: boolean;
  workspaceRoot: string;
  cliPath: string;
  commandPath: string;
  dbPath: string;
  checks: HookSmokeCheck[];
  reasons: string[];
}

export interface HookDoctorResult {
  ok: boolean;
  workspaceRoot: string;
  cliPath: string;
  dbPath: string;
  checks: HookSmokeCheck[];
  agents: Record<NativeHookAgent, HookSmokeResult>;
}

export interface HookInstallOptions {
  smokeRunner?: (agent: NativeHookAgent, cwd: string) => HookSmokeResult;
}

const HOOK_MATCHER = "Bash|Read|Write|Edit|MultiEdit|WebFetch|WebSearch|mcp__.*";
const CLAUDE_HOOK_ID = "agent hook claude";
const CLAUDE_POST_HOOK_ID = "agent hook claude --post";
const CODEX_HOOK_ID = "agent hook codex";
const CODEX_POST_HOOK_ID = "agent hook codex --post";

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readJson(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function currentCliPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "cli.js"),
    path.resolve(moduleDir, "..", "dist", "cli.js"),
    path.resolve(process.cwd(), "dist", "cli.js"),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return candidates[0];
}

export function getBuiltCliPath(): string {
  return currentCliPath();
}

function nodeHookCommand(hookId: string): string {
  const cliPath = currentCliPath();
  if (!fs.existsSync(cliPath)) {
    throw new Error("Built Termyte CLI is missing. Run: npm run build");
  }
  return `${quote(process.execPath)} ${quote(cliPath)} ${hookId}`;
}

export function getNativeHookCommand(agent: NativeHookAgent): { cliPath: string; commandPath: string } {
  const hookId = agent === "claude" ? CLAUDE_HOOK_ID : CODEX_HOOK_ID;
  const cliPath = currentCliPath();
  return {
    cliPath,
    commandPath: `${quote(process.execPath)} ${quote(cliPath)} ${hookId}`,
  };
}

function quote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function payloadHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function toolCallId(payload: Record<string, unknown>): string | undefined {
  return safeString(payload.tool_call_id)
    ?? safeString(payload.toolCallId)
    ?? safeString(payload.tool_use_id)
    ?? safeString(payload.toolUseId)
    ?? safeString(payload.commandCorrelationId)
    ?? safeString(payload.id);
}

function hookEventName(payload: Record<string, unknown>, phase: NativeHookPhase): string {
  return safeString(payload.hook_event_name ?? payload.hookEventName) ?? (phase === "post" ? "PostToolUse" : "PreToolUse");
}

function hookResponse(agent: NativeHookAgent, eventName: string, decision: Decision, reason: string, ledgerId?: number, safeAlternative?: string): string {
  if (decision === "allow") {
    return "";
  }

  if (agent === "claude") {
    const permissionDecision = evaluationDecisionForHook(decision);
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision,
        permissionDecisionReason: `Termyte ${decision}: ${reason}`,
        ...(safeAlternative ? { safeAlternative } : {}),
      },
      termyte: {
        decision,
        ledgerId,
      },
    })}\n`;
  }

  if (decision === "warn" || decision === "ask") {
    return `${JSON.stringify({
      systemMessage: `Termyte ${decision}: ${reason}${safeAlternative ? ` Safe alternative: ${safeAlternative}` : ""}`,
    })}\n`;
  }

  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision: "deny",
      permissionDecisionReason: `Termyte block: ${reason}`,
      ...(safeAlternative ? { safeAlternative } : {}),
    },
    termyte: {
      decision,
      ledgerId,
    },
  })}\n`;
}

function blockedFailure(agent: NativeHookAgent, phase: NativeHookPhase, reason: string, command = ""): NativeHookResult {
  return {
    exitCode: 0,
    stdout: hookResponse(agent, phase === "post" ? "PostToolUse" : "PreToolUse", "block", reason),
    stderr: "",
    decision: "block",
    command,
    reason,
  };
}

function outcomeFromPayload(payload: Record<string, unknown>, decision: Decision): ExecutionOutcome {
  const exitCode = typeof payload.exit_code === "number"
    ? payload.exit_code
    : typeof payload.exitCode === "number"
      ? payload.exitCode
      : typeof payload.status_code === "number"
        ? payload.status_code
        : decision === "block"
          ? 1
          : 0;

  const stderr = safeString(payload.stderr) ?? safeString(payload.error) ?? "";
  const stdout = safeString(payload.stdout) ?? safeString(payload.output) ?? safeString(payload.resultText) ?? "";
  const status = stderr || safeString(payload.errorMessage) || safeString(payload.failureReason)
    ? "failed"
    : exitCode === 0
      ? "executed"
      : "failed";

  return {
    status,
    exitCode,
    stdout: stdout ? `${stdout}\n` : "",
    stderr: stderr ? `${stderr}\n` : "",
    durationMs: typeof payload.duration_ms === "number" ? payload.duration_ms : typeof payload.durationMs === "number" ? payload.durationMs : 0,
    errorMessage: safeString(payload.errorMessage) ?? safeString(payload.failureReason),
  };
}

function correlationFromAction(sessionId: string | undefined, actionHash: string, toolCallIdValue?: string): string {
  return toolCallIdValue ? `tool:${toolCallIdValue}` : `session:${sessionId ?? "unknown"}:${actionHash}`;
}

function hookFailClosedOverride(
  action: ReturnType<typeof normalizeHookAction>,
  evaluation: ReturnType<typeof evaluateAction>,
): { reason: string; safeAlternative: string } | null {
  const parsed = evaluation.parsedAction;
  const sensitiveHookTarget = (action.kind === "file.write" || action.kind === "file.edit")
    && evaluation.targets.targetClasses.some((entry) => {
      return entry.category === "config"
        || entry.category === "environment"
        || entry.category === "home"
        || entry.category === "git-metadata"
        || entry.category === "filesystem-root"
        || entry.category === "workspace-root";
    });

  if (action.kind === "mcp.tool_call" && shouldBlockMcpTool(action.toolName ?? "")) {
    return {
      reason: `MCP tool call is blocked: ${action.toolName ?? "unknown"}.`,
      safeAlternative: "Use the Termyte MCP wrapper for the same workflow, or narrow the tool call first.",
    };
  }

  if (parsed.semanticId === "git.push.force") {
    return {
      reason: "Force-pushes are blocked in native hooks.",
      safeAlternative: "Use a normal git push, or move the work onto a feature branch.",
    };
  }

  if (parsed.semanticId.startsWith("filesystem.delete")) {
    return {
      reason: "Destructive delete is blocked in native hooks.",
      safeAlternative: "Target a narrower path and preview the change before deleting anything.",
    };
  }

  if (parsed.semanticId === "secret.access" || sensitiveHookTarget) {
    return {
      reason: "Sensitive file access is blocked in native hooks.",
      safeAlternative: "Use the approved secret manager or edit a non-sensitive file first.",
    };
  }

  return null;
}

function createPlannedHookRecord(
  ledger: Ledger,
  action: ReturnType<typeof normalizeHookAction>,
  evaluation: ReturnType<typeof evaluateAction>,
  env: NodeJS.ProcessEnv,
  metadata: Record<string, unknown>,
): number {
  const decision = evaluation.decision;
  const status = decision === "block" ? "blocked" : "planned";
  return ledger.createHookRecord(
    evaluation.parsedAction,
    evaluation.targets,
    redactEnvKeys(env),
    {
      ...metadata,
      correlationKey: correlationFromAction(metadata.sessionId as string | undefined, action.inputHash, action.toolCallId),
      runtime: "agent-hook",
      hookRuntime: true,
      finalDecision: decision,
      preHookPhase: action.phase,
      source: "agent-hook",
      safeAlternative: evaluation.safeAlternative,
      risk: evaluation.risk,
      policy: evaluation.policy,
      memoryMatches: evaluation.memoryMatches,
      status,
    },
    decision,
    status,
  );
}

function updateHookRecord(
  ledger: Ledger,
  action: ReturnType<typeof normalizeHookAction>,
  evaluation: ReturnType<typeof evaluateAction>,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  metadata: Record<string, unknown>,
): { ledgerId: number; outcome: ExecutionOutcome; finalDecision: Decision; reason: string } {
  const correlation = correlationFromAction(metadata.sessionId as string | undefined, action.inputHash, action.toolCallId);
  const existing = ledger.findLatestByMetadataKey("correlationKey", correlation) ?? ledger.findLatestByMetadataKey("commandCorrelationId", action.toolCallId ?? "");
  const finalDecision = evaluation.decision;
  const reason = evaluation.reason;
  const outcome = outcomeFromPayload(payload, finalDecision);
  const ledgerId = existing?.id ?? ledger.createHookRecord(
    evaluation.parsedAction,
    evaluation.targets,
    redactEnvKeys(env),
    {
      ...metadata,
      correlationKey: correlation,
      runtime: "agent-hook",
      hookRuntime: true,
      finalDecision,
      postHookPhase: action.phase,
      source: "agent-hook",
      safeAlternative: evaluation.safeAlternative,
      risk: evaluation.risk,
      policy: evaluation.policy,
      memoryMatches: evaluation.memoryMatches,
    },
    finalDecision,
    outcome.status,
  );

  ledger.finalize(ledgerId, finalDecision, outcome, evaluation.risk.score, reason, {
    endedAt: new Date().toISOString(),
    durationMs: outcome.durationMs,
    runtime: "agent-hook",
    hookRuntime: true,
    agentName: action.agent,
    postHookPhase: action.phase,
    toolName: action.toolName,
    sessionId: action.sessionId,
    correlationKey: correlation,
  });
  return { ledgerId, outcome, finalDecision, reason };
}

export function handleAgentHookInvocation(options: NativeHookInvocation): NativeHookResult {
  let payload: Record<string, unknown>;
  try {
    payload = readJson(options.input);
  } catch (error) {
    return blockedFailure(options.agent, options.phase, `Invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const cwd = path.resolve(
    safeString(payload.cwd)
      ?? options.env?.TERMYTE_WORKSPACE
      ?? options.env?.TERMYTE_WORKSPACE_ROOT
      ?? options.cwd
      ?? process.cwd(),
  );
  const dbPath = options.dbPath ?? options.env?.TERMYTE_DB_PATH ?? defaultDbPath(cwd);
  const sessionId = options.env?.TERMYTE_SESSION_ID ?? safeString(payload.session_id ?? payload.sessionId);
  const toolCall = toolCallId(payload);
  const eventName = hookEventName(payload, options.phase);
  const hookAction = normalizeHookAction({
    agent: options.agent,
    phase: options.phase,
    payload,
    cwd,
    sessionId,
    toolCallId: toolCall,
  });
  const evaluation = evaluateAction(hookAction, {
    cwd,
    dbPath,
    applyMemory: true,
    preferAskForWarnings: options.phase === "pre",
  });

  const override = options.phase === "pre" ? hookFailClosedOverride(hookAction, evaluation) : null;
  if (override) {
    evaluation.decision = "block";
    evaluation.reason = override.reason;
    evaluation.safeAlternative = override.safeAlternative;
  }

  try {
    const dbContext = openDatabase(dbPath);
    const ledger = new Ledger(dbContext.db);
    const memory = new MemoryEngine(dbContext.db);
    const metadata = {
      cwd,
      agentName: options.agent,
      eventName,
      toolName: hookAction.toolName,
      sessionId,
      toolCallId: toolCall,
      correlationKey: correlationFromAction(sessionId, hookAction.inputHash, toolCall),
      payloadHash: payloadHash(options.input),
      payload: payload,
    };

    if (options.phase === "pre") {
      const plannedId = createPlannedHookRecord(ledger, hookAction, evaluation, options.env ?? process.env, metadata);
      if (evaluation.decision === "block") {
        const outcome = {
          status: "blocked" as const,
          exitCode: 1,
          stdout: "",
          stderr: `${evaluation.reason}\n`,
          durationMs: 0,
        };
        ledger.finalize(plannedId, "block", outcome, evaluation.risk.score, evaluation.reason, {
          ...metadata,
          endedAt: new Date().toISOString(),
          runtime: "agent-hook",
          hookRuntime: true,
          safeAlternative: evaluation.safeAlternative,
        });
        memory.observe(evaluation.parsedAction, "block", outcome, cwd);
        return {
          exitCode: 0,
          stdout: hookResponse(options.agent, eventName, "block", evaluation.reason, plannedId, evaluation.safeAlternative),
          stderr: "",
          decision: "block",
          ledgerId: plannedId,
          command: hookAction.command,
          reason: evaluation.reason,
        };
      }

      return {
        exitCode: 0,
        stdout: hookResponse(options.agent, eventName, evaluation.decision, evaluation.reason, plannedId, evaluation.safeAlternative),
        stderr: "",
        decision: evaluation.decision,
        ledgerId: plannedId,
        command: hookAction.command,
        reason: evaluation.reason,
      };
    }

    const finalized = updateHookRecord(ledger, hookAction, evaluation, payload, options.env ?? process.env, metadata);
    memory.observe(evaluation.parsedAction, finalized.finalDecision, finalized.outcome, cwd);
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      decision: finalized.finalDecision,
      ledgerId: finalized.ledgerId,
      command: hookAction.command,
      reason: finalized.reason,
    };
  } catch (error) {
    return blockedFailure(options.agent, options.phase, `Termyte hook evaluation failed: ${error instanceof Error ? error.message : String(error)}`, hookAction.command);
  }
}

function readStdin(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => resolve(data));
    stream.on("error", reject);
  });
}

export async function runAgentHookCli(
  agent: NativeHookAgent,
  args: string[],
  stdin: NodeJS.ReadableStream = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<NativeHookResult> {
  const input = await readStdin(stdin);
  return handleAgentHookInvocation({
    agent,
    phase: args.includes("--post") ? "post" : "pre",
    input,
    env,
  });
}

function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = JSON.parse(raw) as unknown;
  return safeObject(parsed);
}

function writeJsonFile(filePath: string, value: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function backupJsonFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
  return backupPath;
}

function mergeHookConfig(existing: Record<string, unknown>, event: "PreToolUse" | "PostToolUse", matcher: string, hookId: string): void {
  const hooks = safeObject(existing.hooks);
  existing.hooks = hooks;
  const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  const command = nodeHookCommand(hookId);
  const nextEntry = {
    matcher,
    hooks: [
      {
        command,
        commandWindows: command,
      },
    ],
  };
  const filtered = entries.filter((entry) => JSON.stringify(entry).includes("agent hook ") === false);
  hooks[event] = [...filtered, nextEntry];
}

function removeTermyteHookConfig(existing: Record<string, unknown>): boolean {
  const hooks = safeObject(existing.hooks);
  let changed = false;
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    const nextEntries = entries.filter((entry) => JSON.stringify(entry).includes("agent hook ") === false);
    if (nextEntries.length !== entries.length) {
      changed = true;
      if (nextEntries.length > 0) {
        hooks[event] = nextEntries;
      } else {
        delete hooks[event];
      }
    }
  }
  if (Object.keys(hooks).length === 0 && existing.hooks && typeof existing.hooks === "object") {
    delete existing.hooks;
    changed = true;
  }
  return changed;
}

function hookSmokeEnvironment(workspaceRoot: string, dbPath: string, agent: NativeHookAgent): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TERMYTE_SESSION_ID: `tm_hook_smoke_${agent}`,
    TERMYTE_DB_PATH: dbPath,
    TERMYTE_WORKSPACE: workspaceRoot,
    TERMYTE_WORKSPACE_ROOT: workspaceRoot,
  };
}

function smokeCheck(id: string, label: string, ok: boolean, message: string): HookSmokeCheck {
  return {
    id,
    label,
    status: ok ? "PASS" : "FAIL",
    message,
  };
}

function smokeChecksReport(checks: HookSmokeCheck[]): { ok: boolean; reasons: string[] } {
  return {
    ok: checks.every((check) => check.status === "PASS"),
    reasons: checks.filter((check) => check.status !== "PASS").map((check) => `${check.label}: ${check.message}`),
  };
}

function invokeHook(agent: NativeHookAgent, phase: NativeHookPhase, payload: Record<string, unknown>, env: NodeJS.ProcessEnv, cliPath: string): NativeHookResult {
  const args = [cliPath, "agent", "hook", agent];
  if (phase === "post") {
    args.push("--post");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: safeString(payload.cwd) ?? env.TERMYTE_WORKSPACE ?? process.cwd(),
    env,
    input: `${JSON.stringify(payload)}\n`,
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    exitCode: typeof result.status === "number" ? result.status : 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    decision: result.status === 0 ? ((result.stdout ?? "").trim().length > 0 ? "block" : "allow") : "block",
    command: args.join(" "),
    reason: result.status === 0 ? "hook invocation completed" : (result.stderr || result.stdout || result.error?.message || "hook invocation failed"),
  };
}

export function runHookSmoke(agent: NativeHookAgent, cwd = process.cwd()): HookSmokeResult {
  const workspaceRoot = path.resolve(cwd);
  const cliPath = currentCliPath();
  const { commandPath } = getNativeHookCommand(agent);
  const dbPath = defaultDbPath(workspaceRoot);
  const checks: HookSmokeCheck[] = [];

  checks.push(smokeCheck("cli.path", "CLI path exists", fs.existsSync(cliPath), `Resolved CLI path: ${cliPath}`));
  checks.push(smokeCheck("hook.command", "Hook command exists", fs.existsSync(cliPath), `Command path: ${commandPath}`));

  try {
    openDatabase(dbPath);
    checks.push(smokeCheck("db.writable", "Termyte DB is writable", fs.existsSync(dbPath), `Database path: ${dbPath}`));
  } catch (error) {
    checks.push(smokeCheck("db.writable", "Termyte DB is writable", false, error instanceof Error ? error.message : String(error)));
  }

  const env = hookSmokeEnvironment(workspaceRoot, dbPath, agent);

  const allowPayload = {
    hook_event_name: "PreToolUse",
    cwd: workspaceRoot,
    session_id: `smoke-${agent}`,
    tool_call_id: `allow-${agent}`,
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
  };
  const allow = invokeHook(agent, "pre", allowPayload, env, cliPath);
  const allowRecord = new Ledger(openDatabase(dbPath).db).findLatestByMetadataKey("correlationKey", `tool:allow-${agent}`);
  checks.push(smokeCheck(
    "stdin.allow",
    "Hook receives stdin JSON and allows safe input",
    allow.exitCode === 0 && allow.stdout === "" && allow.decision === "allow" && allowRecord?.decision === "allow" && allowRecord?.status === "planned",
    allow.stderr || allow.reason,
  ));

  const blockPayload = {
    hook_event_name: "PreToolUse",
    cwd: workspaceRoot,
    session_id: `smoke-${agent}`,
    tool_call_id: `block-${agent}`,
    tool_name: "Bash",
    tool_input: { command: "git push --force origin main" },
  };
  const block = invokeHook(agent, "pre", blockPayload, env, cliPath);
  const blockRecord = new Ledger(openDatabase(dbPath).db).findLatestByMetadataKey("correlationKey", `tool:block-${agent}`);
  let blockJsonOk = false;
  try {
    const parsed = JSON.parse(block.stdout || "{}") as { hookSpecificOutput?: { permissionDecision?: string } };
    blockJsonOk = parsed.hookSpecificOutput?.permissionDecision === "deny";
  } catch {
    blockJsonOk = false;
  }
  checks.push(smokeCheck(
    "stdin.block",
    "Blocked hook emits Claude deny JSON and logs the block",
    block.exitCode === 0 && block.decision === "block" && blockJsonOk && blockRecord?.decision === "block" && blockRecord?.status === "blocked",
    block.stderr || block.reason,
  ));

  const correlationId = `post-${agent}`;
  const pre = invokeHook(agent, "pre", {
    hook_event_name: "PreToolUse",
    cwd: workspaceRoot,
    session_id: `smoke-${agent}`,
    tool_call_id: correlationId,
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
  }, env, cliPath);
  const post = invokeHook(agent, "post", {
    hook_event_name: "PostToolUse",
    cwd: workspaceRoot,
    session_id: `smoke-${agent}`,
    tool_call_id: correlationId,
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
    stdout: "clean\n",
    exit_code: 0,
  }, env, cliPath);
  const finalizedRecord = new Ledger(openDatabase(dbPath).db).findLatestByMetadataKey("correlationKey", `tool:${correlationId}`);
  checks.push(smokeCheck(
    "stdin.post",
    "PostToolUse finalizes the ledger and memory path",
    pre.decision === "allow" && post.exitCode === 0 && finalizedRecord?.status === "executed" && finalizedRecord?.decision === "allow",
    post.stderr || post.reason,
  ));

  const report = smokeChecksReport(checks);
  return {
    agent,
    ok: report.ok,
    workspaceRoot,
    cliPath,
    commandPath,
    dbPath,
    checks,
    reasons: report.reasons,
  };
}

export function runHooksDoctor(cwd = process.cwd()): HookDoctorResult {
  const workspaceRoot = path.resolve(cwd);
  const cliPath = currentCliPath();
  const dbPath = defaultDbPath(workspaceRoot);
  const checks: HookSmokeCheck[] = [];

  checks.push(smokeCheck("cli.path", "Built CLI path exists", fs.existsSync(cliPath), cliPath));
  try {
    openDatabase(dbPath);
    checks.push(smokeCheck("db.writable", "Workspace DB is writable", fs.existsSync(dbPath), dbPath));
  } catch (error) {
    checks.push(smokeCheck("db.writable", "Workspace DB is writable", false, error instanceof Error ? error.message : String(error)));
  }

  const agents: Record<NativeHookAgent, HookSmokeResult> = {
    claude: runHookSmoke("claude", workspaceRoot),
    codex: runHookSmoke("codex", workspaceRoot),
  };

  checks.push(...agents.claude.checks.map((check) => ({ ...check, label: `Claude ${check.label}`, id: `claude.${check.id}` })));
  checks.push(...agents.codex.checks.map((check) => ({ ...check, label: `Codex ${check.label}`, id: `codex.${check.id}` })));

  return {
    ok: checks.every((check) => check.status === "PASS"),
    workspaceRoot,
    cliPath,
    dbPath,
    checks,
    agents,
  };
}

export function installAgentHooks(agent: NativeHookAgent, cwd = process.cwd(), options: HookInstallOptions = {}): AgentInstallResult {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const config = readJsonFile(configPath);
  const existingText = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  if (agent === "claude") {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CLAUDE_HOOK_ID);
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CLAUDE_POST_HOOK_ID);
  } else {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CODEX_HOOK_ID);
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CODEX_POST_HOOK_ID);
  }

  const nextText = `${JSON.stringify(config, null, 2)}\n`;
  const changed = nextText !== existingText;
  const backupPath = changed ? backupJsonFile(configPath) : null;
  writeJsonFile(configPath, config);
  const result = (options.smokeRunner ?? runHookSmoke)(agent, workspaceRoot);
  const changes = [
    `installed PreToolUse hook for ${agent}`,
    `installed PostToolUse hook for ${agent}`,
    ...(backupPath ? [`backed up previous config to ${backupPath}`] : []),
  ];
  return {
    agent,
    path: configPath,
    installed: true,
    active: result.ok,
    backupPath: backupPath ?? undefined,
    changes,
    message: result.ok
      ? `Installed Termyte ${agent} hooks at ${configPath} and verified them with a live smoke test.`
      : agent === "codex"
        ? `Installed Termyte Codex hook config at ${configPath}, but live smoke verification failed. Codex native hooks unavailable. Termyte MCP and Codex sandbox/approval mode remain available. ${result.reasons.join("; ")}`
        : `Installed Termyte ${agent} hook config at ${configPath}, but live smoke failed. Use Termyte MCP for the fallback path. ${result.reasons.join("; ")}`,
  };
}

export function uninstallAgentHooks(agent: NativeHookAgent, cwd = process.cwd()): AgentUninstallResult {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");

  if (!fs.existsSync(configPath)) {
    return {
      agent,
      path: configPath,
      removed: false,
      message: `No Termyte ${agent} hook config found at ${configPath}`,
    };
  }

  const config = readJsonFile(configPath);
  const changed = removeTermyteHookConfig(config);
  if (changed && Object.keys(config).length > 0) {
    writeJsonFile(configPath, config);
  } else {
    fs.rmSync(configPath, { force: true });
  }

  return {
    agent,
    path: configPath,
    removed: true,
    message: `Removed Termyte ${agent} hooks from ${configPath}`,
  };
}

export function verifyAgentHooks(agent: NativeHookAgent, cwd = process.cwd()): AgentHookVerification {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const reasons: string[] = [];
  if (!fs.existsSync(configPath)) {
    reasons.push(`hook config missing: ${configPath}`);
  } else {
    const config = readJsonFile(configPath);
    const preCommands = hookCommands(config, agent === "claude" ? CLAUDE_HOOK_ID : CODEX_HOOK_ID);
    const postCommands = hookCommands(config, agent === "claude" ? CLAUDE_POST_HOOK_ID : CODEX_POST_HOOK_ID);
    if (preCommands.length === 0) {
      reasons.push("missing PreToolUse handler");
    }
    if (postCommands.length === 0) {
      reasons.push("missing PostToolUse handler");
    }
    const smoke = runHookSmoke(agent, workspaceRoot);
    if (!smoke.ok) {
      if (agent === "codex") {
        reasons.push("Codex native hooks unavailable. Termyte MCP and Codex sandbox/approval mode remain available.");
      }
      reasons.push(...smoke.reasons);
    }
  }

  return {
    agent,
    ok: reasons.length === 0,
    path: configPath,
    reasons,
  };
}

function hookCommands(config: Record<string, unknown>, hookId: string): string[] {
  const hooks = safeObject(config.hooks);
  const commands: string[] = [];
  for (const event of ["PreToolUse", "PostToolUse"] as const) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
    for (const entry of entries) {
      const entryObject = safeObject(entry);
      const hookEntries = Array.isArray(entryObject.hooks) ? entryObject.hooks as unknown[] : [];
      for (const hookEntry of hookEntries) {
        const hookObject = safeObject(hookEntry);
        const command = safeString(hookObject.command);
        const commandWindows = safeString(hookObject.commandWindows);
        if (command?.includes(hookId)) commands.push(command);
        if (commandWindows?.includes(hookId)) commands.push(commandWindows);
      }
    }
  }
  return commands;
}

export function formatAgentUninstallResult(result: AgentUninstallResult): string {
  return result.message;
}

export function formatAgentInstallResult(result: AgentInstallResult): string {
  return [
    result.message,
    "Changes:",
    ...result.changes.map((change) => `  - ${change}`),
    ...(result.backupPath ? [`Backup: ${result.backupPath}`] : []),
    `Active: ${result.active ? "yes" : "no"}`,
    "",
    "Next steps:",
    `  termyte doctor`,
    `  termyte hooks doctor`,
    `  termyte hooks smoke ${result.agent}`,
    `  termyte run ${result.agent}`,
    `  termyte mcp install ${result.agent}`,
  ].join(os.EOL);
}

export function formatAgentHookVerification(verification: AgentHookVerification): string {
  if (verification.ok) {
    return `Termyte ${verification.agent} hooks verified at ${verification.path}`;
  }
  if (verification.agent === "codex") {
    return [
      `Termyte ${verification.agent} hooks are not ready.`,
      ...verification.reasons.map((reason) => `  - ${reason}`),
      "",
      "Codex native hooks unavailable. Termyte MCP and Codex sandbox/approval mode remain available.",
    ].join(os.EOL);
  }
  return [
    `Termyte ${verification.agent} hooks are not ready.`,
    ...verification.reasons.map((reason) => `  - ${reason}`),
    "",
    `Use Termyte MCP if native hook smoke fails: termyte mcp install ${verification.agent}`,
  ].join(os.EOL);
}

export function isNativeHookAgent(agentName: string): agentName is NativeHookAgent {
  return agentName === "claude" || agentName === "codex";
}

export function formatAgentHookResponse(agent: NativeHookAgent, eventName: string, decision: Decision, reason: string, ledgerId?: number): string {
  return hookResponse(agent, eventName, decision, reason, ledgerId);
}

export function formatHookSmokeResult(result: HookSmokeResult, json = false): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return [
    `Termyte hook smoke: ${result.agent}`,
    `  CLI path: ${result.cliPath}`,
    `  Hook command: ${result.commandPath}`,
    `  DB path: ${result.dbPath}`,
    ...result.checks.map((check) => `  ${check.status} ${check.label}: ${check.message}`),
    result.ok ? "  Result: ready" : `  Result: not ready (${result.reasons.join("; ")})`,
  ].join(os.EOL);
}

export function formatHookDoctorResult(result: HookDoctorResult, json = false): string {
  if (json) {
    return JSON.stringify(result, null, 2);
  }
  return [
    "Termyte hooks doctor",
    `  Workspace: ${result.workspaceRoot}`,
    `  CLI path: ${result.cliPath}`,
    `  DB path: ${result.dbPath}`,
    ...result.checks.map((check) => `  ${check.status} ${check.label}: ${check.message}`),
    "",
    `  Claude smoke: ${result.agents.claude.ok ? "PASS" : "FAIL"}`,
    `  Codex smoke: ${result.agents.codex.ok ? "PASS" : "FAIL"}`,
    result.ok ? "  Result: ready" : "  Result: not ready",
  ].join(os.EOL);
}
