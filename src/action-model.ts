import crypto from "node:crypto";
import { redactCommand } from "./redact.js";
import { parseAction } from "./parser.js";
import type { ParsedAction } from "./types.js";

export type RuntimeActionKind =
  | "shell.command"
  | "file.read"
  | "file.write"
  | "file.edit"
  | "git.push"
  | "git.destructive"
  | "package.install"
  | "package.publish"
  | "mcp.tool_call"
  | "network.request"
  | "unknown";

export type RuntimeActionSource = "runtime" | "hook" | "mcp";
export type HookAgent = "claude" | "codex";
export type HookPhase = "pre" | "post";

export interface RuntimeAction {
  kind: RuntimeActionKind;
  source: RuntimeActionSource;
  command: string;
  normalizedCommand: string;
  redactedCommand: string;
  cwd: string;
  inputHash: string;
  toolName?: string;
  toolCallId?: string;
  sessionId?: string;
  agent?: HookAgent;
  phase?: HookPhase;
  parsed: ParsedAction;
  payload?: Record<string, unknown>;
}

export interface NormalizedActionContext {
  source?: RuntimeActionSource;
  cwd?: string;
  agent?: HookAgent;
  phase?: HookPhase;
  sessionId?: string;
  toolName?: string;
  toolCallId?: string;
  payload?: Record<string, unknown>;
}

export function normalizeAction(command: string, context: NormalizedActionContext = {}): RuntimeAction {
  const parsed = parseAction(command);
  return {
    kind: inferRuntimeKind(parsed, context.toolName),
    source: context.source ?? "runtime",
    command,
    normalizedCommand: command.trim().replace(/\s+/g, " "),
    redactedCommand: redactCommand(command),
    cwd: context.cwd ?? process.cwd(),
    inputHash: hashText([command, context.toolName ?? "", context.toolCallId ?? "", context.sessionId ?? "", context.source ?? "runtime"].join("\u0000")),
    toolName: context.toolName,
    toolCallId: context.toolCallId,
    sessionId: context.sessionId,
    agent: context.agent,
    phase: context.phase,
    parsed,
    payload: context.payload,
  };
}

export function normalizeHookAction(input: {
  agent: HookAgent;
  phase: HookPhase;
  payload: Record<string, unknown>;
  cwd: string;
  sessionId?: string;
  toolCallId?: string;
}): RuntimeAction {
  const toolName = safeString(
    input.payload.tool_name ??
    input.payload.toolName ??
    input.payload.name ??
    input.payload.tool ??
    input.payload.tool_name
  ) ?? "unknown";
  const toolInput = safeToolInput(
    input.payload.tool_input ??
    input.payload.toolInput ??
    input.payload.input ??
    input.payload.arguments ??
    input.payload.args ??
    input.payload.parameters
  );
  const command = commandFromTool(toolName, toolInput);
  const hasMeaningfulCommand = command.trim().length > 0;
  const normalizedToolName = !isSupportedHookTool(toolName) || !hasMeaningfulCommand ? "unknown" : toolName;
  const normalizedCommand = hasMeaningfulCommand ? command : `unknown ${stableJson(toolInput)}`;
  return normalizeAction(normalizedCommand, {
    source: "hook",
    cwd: input.cwd,
    agent: input.agent,
    phase: input.phase,
    sessionId: input.sessionId,
    toolName: normalizedToolName,
    toolCallId: input.toolCallId,
    payload: input.payload,
  });
}

export function normalizeToolCallAction(input: {
  toolName: string;
  arguments?: Record<string, unknown>;
  cwd: string;
  source?: RuntimeActionSource;
  sessionId?: string;
  toolCallId?: string;
}): RuntimeAction {
  const command = `mcp ${input.toolName}${Object.keys(input.arguments ?? {}).length > 0 ? ` ${JSON.stringify(input.arguments)}` : ""}`;
  return normalizeAction(command, {
    source: input.source ?? "mcp",
    cwd: input.cwd,
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    sessionId: input.sessionId,
    payload: input.arguments,
  });
}

export function correlationKey(action: RuntimeAction): string {
  return action.toolCallId && action.toolCallId.trim().length > 0
    ? `tool:${action.toolCallId}`
    : `session:${action.sessionId ?? "unknown"}:${action.inputHash}`;
}

function inferRuntimeKind(parsed: ParsedAction, toolName?: string): RuntimeActionKind {
  const loweredTool = toolName?.toLowerCase() ?? "";
  if (loweredTool === "unknown") return "unknown";
  if (loweredTool === "read") return "file.read";
  if (loweredTool === "write") return "file.write";
  if (loweredTool === "edit" || loweredTool === "multiedit") return "file.edit";
  if (loweredTool.startsWith("webfetch") || loweredTool.startsWith("websearch")) return "network.request";
  if (loweredTool.startsWith("mcp__")) return "mcp.tool_call";

  switch (parsed.kind) {
    case "filesystem.write":
      return "file.write";
    case "git.push":
      return "git.push";
    case "git.destructive":
      return "git.destructive";
    case "package.publish":
      return "package.publish";
    case "package.install":
      return "shell.command";
    case "remote-script.execution":
      return "network.request";
    case "privilege.escalation":
    case "secret.access":
    case "docker.destructive":
    case "deploy.mutation":
    case "sql.destructive":
    case "shell.generic":
    default:
      return "shell.command";
  }
}

function commandFromTool(toolName: string, toolInput: Record<string, unknown>): string {
  const path = safeString(toolInput.file_path ?? toolInput.path ?? toolInput.target ?? toolInput.filename) ?? "";
  const content = safeString(toolInput.content ?? toolInput.text ?? toolInput.patch ?? toolInput.diff) ?? "";
  const command = safeString(toolInput.command)
    ?? safeString(toolInput.cmd)
    ?? safeString(toolInput.shell_command)
    ?? safeString(toolInput.shellCommand)
    ?? safeString(toolInput.query)
    ?? safeString(toolInput.url)
    ?? safeString(toolInput.prompt)
    ?? "";

  if (toolName === "Bash") {
    return command;
  }
  if (toolName === "Read") {
    return path ? commandOrRead(path) : "";
  }
  if (toolName === "Write") {
    return path ? commandOrWrite(path, content) : "";
  }
  if (toolName === "Edit" || toolName === "MultiEdit") {
    return path ? commandOrWrite(path, content) : "";
  }
  if (toolName === "WebFetch" || toolName === "WebSearch") {
    return command ? `curl ${quote(command)}` : "";
  }
  if (toolName.startsWith("mcp__")) {
    return `${toolName} ${stableJson(toolInput)}`;
  }
  if (command) {
    return command;
  }
  return `${toolName} ${stableJson(toolInput)}`.trim();
}

function isSupportedHookTool(toolName: string): boolean {
  return toolName === "Bash"
    || toolName === "Read"
    || toolName === "Write"
    || toolName === "Edit"
    || toolName === "MultiEdit"
    || toolName === "WebFetch"
    || toolName === "WebSearch"
    || toolName.startsWith("mcp__")
    || toolName === "unknown";
}

function commandOrRead(filePath: string): string {
  return process.platform === "win32"
    ? `Get-Content -LiteralPath ${quote(filePath)} -Raw`
    : `cat ${quote(filePath)}`;
}

function commandOrWrite(filePath: string, content: string): string {
  return process.platform === "win32"
    ? `Set-Content -LiteralPath ${quote(filePath)} -Value ${quote(content)}`
    : `printf %s ${quote(content)} > ${quote(filePath)}`;
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeToolInput(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    return { command: value };
  }
  if (Array.isArray(value)) {
    return { items: value };
  }
  return safeObject(value);
}

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.keys(value as Record<string, unknown>).sort().reduce((acc, key) => {
    (acc as Record<string, unknown>)[key] = sortValue((value as Record<string, unknown>)[key]);
    return acc;
  }, {} as Record<string, unknown>);
}

function quote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
