import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDbPath, openDatabase } from "./db.js";
import { Ledger } from "./ledger.js";
import { MemoryEngine } from "./memory.js";
import { inspectAction } from "./runtime.js";
import { redactCommand, redactEnvKeys } from "./redact.js";
import type { Decision, ExecutionOutcome } from "./types.js";

export type NativeHookAgent = "claude" | "codex";
export type NativeHookPhase = "pre" | "post";

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
  message: string;
}

export interface AgentHookVerification {
  agent: NativeHookAgent;
  ok: boolean;
  path: string;
  reasons: string[];
}

const HOOK_MATCHER = "Bash|Edit|Write|Read|Glob|Grep|Agent|WebFetch|WebSearch|apply_patch|mcp__.*";
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

function hookPayloadHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function readJson(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Hook payload must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandQuote(value: string): string {
  const normalized = process.platform === "win32" ? value.replace(/\\/g, "/") : value;
  if (process.platform === "win32") {
    return `"${normalized.replace(/"/g, '\\"')}"`;
  }
  return `"${normalized.replace(/(["\\$`])/g, "\\$1")}"`;
}

function currentCliPath(): string {
  const argvCli = process.argv[1];
  if (argvCli && /cli\.(js|ts)$/i.test(path.basename(argvCli))) {
    return path.resolve(argvCli);
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const distCli = path.join(moduleDir, "cli.js");
  if (fs.existsSync(distCli)) {
    return distCli;
  }

  const repoDistCli = path.resolve(moduleDir, "..", "dist", "cli.js");
  if (fs.existsSync(repoDistCli)) {
    return repoDistCli;
  }

  return path.resolve(moduleDir, "cli.js");
}

function nodeHookCommand(hookId: string): string {
  return `node ${commandQuote(currentCliPath())} ${hookId}`;
}

function commandFromHookPayload(payload: Record<string, unknown>): string {
  const toolName = safeString(payload.tool_name) ?? safeString(payload.toolName) ?? "unknown";
  const toolInput = safeObject(payload.tool_input ?? payload.toolInput ?? payload.input);

  if (toolName === "Bash") {
    return safeString(toolInput.command) ?? "";
  }

  if (toolName === "Read") {
    const filePath = safeString(toolInput.file_path ?? toolInput.path);
    return filePath ? `Get-Content -LiteralPath ${shellQuote(filePath)}` : "Get-Content";
  }

  if (toolName === "Write") {
    const filePath = safeString(toolInput.file_path ?? toolInput.path);
    return filePath ? `Set-Content -LiteralPath ${shellQuote(filePath)} -Value [REDACTED]` : "Set-Content";
  }

  if (toolName === "Edit" || toolName === "MultiEdit" || toolName === "apply_patch") {
    const filePath = safeString(toolInput.file_path ?? toolInput.path);
    return filePath ? `Set-Content -LiteralPath ${shellQuote(filePath)} -Value [REDACTED]` : "apply_patch";
  }

  if (toolName === "Glob" || toolName === "Grep") {
    const pattern = safeString(toolInput.pattern) ?? safeString(toolInput.glob) ?? "";
    const targetPath = safeString(toolInput.path ?? toolInput.cwd) ?? ".";
    return `${toolName.toLowerCase()} ${shellQuote(pattern || targetPath)}`;
  }

  if (toolName.startsWith("mcp__")) {
    return `mcp ${toolName}`;
  }

  return `${toolName} ${JSON.stringify(redactHookMetadata(toolInput))}`;
}

function redactHookMetadata(value: unknown): unknown {
  if (typeof value === "string") {
    return redactCommand(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactHookMetadata(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (/(token|secret|password|authorization|bearer|api[_-]?key|credential)/i.test(key)) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = redactHookMetadata(rawValue);
    }
  }
  return redacted;
}

function responseDecision(decision: Decision): "allow" | "deny" | "ask" {
  if (decision === "block") return "deny";
  if (decision === "warn" || decision === "ask") return "ask";
  return "allow";
}

function hookEventName(payload: Record<string, unknown>, phase: NativeHookPhase): string {
  return safeString(payload.hook_event_name ?? payload.hookEventName)
    ?? (phase === "post" ? "PostToolUse" : "PreToolUse");
}

function shouldFailClosedSensitiveMutation(toolName: string, targets: { sensitiveTargets: string[]; protectedTargets: string[] }): boolean {
  return ["Write", "Edit", "MultiEdit", "apply_patch"].includes(toolName)
    && (targets.sensitiveTargets.length > 0 || targets.protectedTargets.length > 0);
}

function agentResponse(agent: NativeHookAgent, eventName: string, decision: Decision, reason: string, ledgerId?: number): string {
  const permissionDecision = responseDecision(decision);
  if (agent === "claude") {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName,
        permissionDecision,
        permissionDecisionReason: `Termyte ${decision}: ${reason}`,
      },
      termyte: {
        decision,
        ledgerId,
      },
    })}\n`;
  }

  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      permissionDecision,
      permissionDecisionReason: `Termyte ${decision}: ${reason}`,
    },
    decision: permissionDecision,
    reason: `Termyte ${decision}: ${reason}`,
    termyte: {
      decision,
      ledgerId,
    },
  })}\n`;
}

function blockedFailure(agent: NativeHookAgent, phase: NativeHookPhase, reason: string, command = ""): NativeHookResult {
  return {
    exitCode: 0,
    stdout: agentResponse(agent, phase === "post" ? "PostToolUse" : "PreToolUse", "block", reason),
    stderr: "",
    decision: "block",
    command,
    reason,
  };
}

export async function handleAgentHookInvocation(options: NativeHookInvocation): Promise<NativeHookResult> {
  let payload: Record<string, unknown>;
  try {
    payload = readJson(options.input);
  } catch (error) {
    return blockedFailure(options.agent, options.phase, `Invalid hook JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const command = commandFromHookPayload(payload);
  if (!command.trim()) {
    return blockedFailure(options.agent, options.phase, "Hook payload did not include an actionable command.", command);
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
  const eventName = hookEventName(payload, options.phase);
  const toolName = safeString(payload.tool_name ?? payload.toolName) ?? "unknown";

  try {
    const report = inspectAction(command, cwd, dbPath);
    const dbContext = openDatabase(dbPath);
    const ledger = new Ledger(dbContext.db);
    const memory = new MemoryEngine(dbContext.db);
    const now = new Date().toISOString();
    const finalDecision = shouldFailClosedSensitiveMutation(toolName, report.targets) ? "block" : report.finalDecision;
    const finalReason = finalDecision !== report.finalDecision
      ? `Native hook fail-closed: ${toolName} targets sensitive or protected paths. ${report.finalReason}`
      : report.finalReason;
    const ledgerId = ledger.createPending(report.action, report.targets, redactEnvKeys(options.env ?? process.env), {
      cwd,
      agentName: options.agent,
      eventName,
      toolName,
      hookPhase: options.phase,
      hookRuntime: true,
      runtime: "agent-hook",
      sessionId,
      payloadHash: hookPayloadHash(options.input),
      payload: redactHookMetadata(payload),
      policy: report.policy,
      memoryMatches: report.memoryMatches,
      risk: report.risk,
      targets: report.targets,
      finalDecision,
      startedAt: now,
    });

    const outcome: ExecutionOutcome = {
      status: finalDecision === "block" ? "blocked" : "executed",
      exitCode: finalDecision === "block" ? 1 : 0,
      stdout: "",
      stderr: finalDecision === "block" ? `${finalReason}\n` : "",
      durationMs: 0,
    };
    ledger.finalize(ledgerId, finalDecision, outcome, report.risk.score, finalReason, {
      endedAt: new Date().toISOString(),
      durationMs: 0,
      executedVia: "agent-hook",
      runtime: "agent-hook",
      hookRuntime: true,
      agentName: options.agent,
      eventName,
      toolName,
      sessionId,
      delegatedExecution: finalDecision !== "block",
    });
    memory.observe(report.action, finalDecision, outcome, cwd);

    return {
      exitCode: 0,
      stdout: agentResponse(options.agent, eventName, finalDecision, finalReason, ledgerId),
      stderr: "",
      decision: finalDecision,
      ledgerId,
      command,
      reason: finalReason,
    };
  } catch (error) {
    return blockedFailure(options.agent, options.phase, `Termyte hook evaluation failed: ${error instanceof Error ? error.message : String(error)}`, command);
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

function ensureHooksObject(existing: Record<string, unknown>): Record<string, unknown> {
  const hooks = safeObject(existing.hooks);
  existing.hooks = hooks;
  return hooks;
}

function mergeHookConfig(existing: Record<string, unknown>, event: "PreToolUse" | "PostToolUse", matcher: string, hookId: string, statusMessage: string): void {
  const hooks = ensureHooksObject(existing);
  const eventEntries = Array.isArray(hooks[event]) ? hooks[event] as unknown[] : [];
  const command = nodeHookCommand(hookId);
  const nextEntry = {
    matcher,
    hooks: [
      {
        type: "command",
        command,
        commandWindows: command,
        timeout: 30,
        statusMessage,
      },
    ],
  };

  const withoutExisting = eventEntries.filter((entry) => JSON.stringify(entry).includes(hookId) === false);
  hooks[event] = [...withoutExisting, nextEntry];
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

export function installAgentHooks(agent: NativeHookAgent, cwd = process.cwd()): AgentInstallResult {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const config = readJsonFile(configPath);

  if (agent === "claude") {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CLAUDE_HOOK_ID, "Checking Termyte policy");
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CLAUDE_POST_HOOK_ID, "Recording Termyte observation");
  } else {
    mergeHookConfig(config, "PreToolUse", HOOK_MATCHER, CODEX_HOOK_ID, "Checking Termyte policy");
    mergeHookConfig(config, "PostToolUse", HOOK_MATCHER, CODEX_POST_HOOK_ID, "Recording Termyte observation");
  }

  writeJsonFile(configPath, config);

  return {
    agent,
    path: configPath,
    installed: true,
    message: `Installed Termyte ${agent} hooks at ${configPath}`,
  };
}

function configContainsCommand(configPath: string, command: string): boolean {
  if (!fs.existsSync(configPath)) {
    return false;
  }
  return fs.readFileSync(configPath, "utf8").includes(command);
}

export function verifyAgentHooks(agent: NativeHookAgent, cwd = process.cwd()): AgentHookVerification {
  const workspaceRoot = path.resolve(cwd);
  const configPath = agent === "claude"
    ? path.join(workspaceRoot, ".claude", "settings.local.json")
    : path.join(workspaceRoot, ".codex", "hooks.json");
  const expectedPre = agent === "claude" ? CLAUDE_HOOK_ID : CODEX_HOOK_ID;
  const expectedPost = agent === "claude" ? CLAUDE_POST_HOOK_ID : CODEX_POST_HOOK_ID;
  const reasons: string[] = [];

  if (!fs.existsSync(configPath)) {
    reasons.push(`hook config missing: ${configPath}`);
  } else {
    const config = readJsonFile(configPath);
    const features = safeObject(config.features);
    if (features.hooks === false || features.codex_hooks === false) {
      reasons.push("hook config disables hooks");
    }
    if (!configContainsCommand(configPath, expectedPre)) {
      reasons.push(`missing PreToolUse handler: ${expectedPre}`);
    }
    if (!configContainsCommand(configPath, expectedPost)) {
      reasons.push(`missing PostToolUse handler: ${expectedPost}`);
    }
  }

  return {
    agent,
    ok: reasons.length === 0,
    path: configPath,
    reasons,
  };
}

export function formatAgentInstallResult(result: AgentInstallResult): string {
  return [
    result.message,
    "",
    "Next steps:",
    `  termyte doctor`,
    `  termyte run ${result.agent}`,
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
    `Fix: termyte install ${verification.agent}`,
  ].join(os.EOL);
}

export function isNativeHookAgent(agentName: string): agentName is NativeHookAgent {
  return agentName === "claude" || agentName === "codex";
}
