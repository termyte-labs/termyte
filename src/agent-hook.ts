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

function nodeHookCommand(hookId: string): string {
  const cliPath = currentCliPath();
  if (!fs.existsSync(cliPath)) {
    throw new Error("Built Termyte CLI is missing. Run: npm run build");
  }
  return `${quote(process.execPath)} ${quote(cliPath)} ${hookId}`;
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

function runGeneratedHookCommand(commandLine: string, cwd: string, input: string): { status: number | null; stdout: string; stderr: string; error?: Error } {
  const result = spawnSync(commandLine, {
    cwd,
    input,
    encoding: "utf8",
    timeout: 30_000,
    shell: true,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error instanceof Error ? result.error : undefined,
  };
}

export async function handleAgentHookInvocation(options: NativeHookInvocation): Promise<NativeHookResult> {
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

export async function runAgentHookCli(agent: NativeHookAgent, args: string[], stdin: NodeJS.ReadableStream = process.stdin): Promise<NativeHookResult> {
  const input = await readStdin(stdin);
  return handleAgentHookInvocation({
    agent,
    phase: args.includes("--post") ? "post" : "pre",
    input,
    env: process.env,
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

function smokeTest(agent: NativeHookAgent, cwd: string): { ok: boolean; reasons: string[] } {
  const allowPayload = JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd,
    session_id: "tm_smoke",
    tool_name: "Bash",
    tool_input: { command: "git status --short" },
  });
  const blockPayload = JSON.stringify({
    hook_event_name: "PreToolUse",
    cwd,
    session_id: "tm_smoke",
    tool_name: "Bash",
    tool_input: { command: "git push --force origin main" },
  });
  const command = nodeHookCommand(agent === "claude" ? CLAUDE_HOOK_ID : CODEX_HOOK_ID);
  const allow = runGeneratedHookCommand(command, cwd, allowPayload);
  const block = runGeneratedHookCommand(command, cwd, blockPayload);
  const reasons: string[] = [];
  if (allow.status !== 0) {
    reasons.push(`allow smoke failed: ${allow.stderr || allow.stdout || allow.error?.message || "unknown"}`);
  }
  if (allow.stdout.trim().length > 0) {
    reasons.push("allow smoke should be silent");
  }
  if (block.status !== 0) {
    reasons.push(`block smoke failed: ${block.stderr || block.stdout || block.error?.message || "unknown"}`);
  }
  try {
    const parsed = JSON.parse(block.stdout || "{}") as { hookSpecificOutput?: { permissionDecision?: string } };
    if (parsed.hookSpecificOutput?.permissionDecision !== "deny") {
      reasons.push("block smoke did not emit deny JSON");
    }
  } catch {
    reasons.push("block smoke emitted invalid JSON");
  }
  return { ok: reasons.length === 0, reasons };
}

export function installAgentHooks(agent: NativeHookAgent, cwd = process.cwd()): AgentInstallResult {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const config = readJsonFile(configPath);

  if (agent === "claude") {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CLAUDE_HOOK_ID);
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CLAUDE_POST_HOOK_ID);
  } else {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CODEX_HOOK_ID);
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CODEX_POST_HOOK_ID);
  }

  writeJsonFile(configPath, config);
  const smoke = smokeTest(agent, workspaceRoot);

  return {
    agent,
    path: configPath,
    installed: true,
    active: smoke.ok,
    message: smoke.ok
      ? `Installed Termyte ${agent} hooks at ${configPath} and verified them with a live smoke test.`
      : `Installed Termyte ${agent} hook config at ${configPath}, but live smoke failed. Use Termyte MCP for the fallback path. ${smoke.reasons.join("; ")}`,
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
    const smoke = smokeTest(agent, workspaceRoot);
    if (!smoke.ok) {
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
    `Active: ${result.active ? "yes" : "no"}`,
    "",
    "Next steps:",
    `  termyte doctor`,
    `  termyte run ${result.agent}`,
    `  termyte mcp install ${result.agent}`,
  ].join(os.EOL);
}

export function formatAgentHookVerification(verification: AgentHookVerification): string {
  if (verification.ok) {
    return `Termyte ${verification.agent} hooks verified at ${verification.path}`;
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
