import path from "node:path";
import readline from "node:readline";
import { defaultDbPath, openDatabase } from "./db.js";
import { replayEntries } from "./format.js";
import { Ledger } from "./ledger.js";
import { inspectAction, runRuntime, type RuntimeResult } from "./runtime.js";
import { runRuntimeProof } from "./proof.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
}

interface ToolCallParams {
  name?: string;
  arguments?: Record<string, unknown>;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpServerOptions {
  cwd?: string;
  dbPath?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

function stringArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const value = args[key];
  return typeof value === "string" ? value : fallback;
}

function booleanArg(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  return typeof value === "boolean" ? value : fallback;
}

function numberArg(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function packageManagerArg(args: Record<string, unknown>): string {
  const manager = stringArg(args, "manager", "npm");
  if (!["npm", "pnpm", "yarn"].includes(manager)) {
    throw new Error(`Unsupported package manager: ${manager}`);
  }
  return manager;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function shellPath(value: string): string {
  return process.platform === "win32" ? psQuote(value) : shQuote(value);
}

function commandForRead(filePath: string): string {
  return process.platform === "win32"
    ? `Get-Content -LiteralPath ${psQuote(filePath)} -Raw`
    : `cat ${shQuote(filePath)}`;
}

function commandForWrite(filePath: string, content: string, append: boolean): string {
  if (process.platform === "win32") {
    return `${append ? "Add-Content" : "Set-Content"} -LiteralPath ${psQuote(filePath)} -Value ${psQuote(content)} -NoNewline`;
  }
  return append
    ? `printf %s ${shQuote(content)} >> ${shQuote(filePath)}`
    : `printf %s ${shQuote(content)} > ${shQuote(filePath)}`;
}

function commandForDelete(filePath: string, recursive: boolean): string {
  if (process.platform === "win32") {
    return `Remove-Item${recursive ? " -Recurse" : ""} -Force -LiteralPath ${psQuote(filePath)}`;
  }
  return `rm ${recursive ? "-rf" : "-f"} ${shQuote(filePath)}`;
}

function resultPayload(result: RuntimeResult): Record<string, unknown> {
  return {
    decision: result.decision,
    status: result.status,
    semanticId: result.semanticId,
    ledgerId: result.ledgerId,
    exitCode: result.exitCode,
    wasExecuted: result.wasExecuted,
    reason: result.reason,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

async function governedCommand(command: string, cwd: string, dbPath: string, dryRun = false): Promise<Record<string, unknown>> {
  const result = await runRuntime({
    command,
    cwd,
    dbPath,
    dryRun,
    approval: async () => false,
    env: process.env,
  });
  return {
    command,
    ...resultPayload(result),
  };
}

function toolText(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

const stringSchema = { type: "string" };
const booleanSchema = { type: "boolean" };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "termyte.git.status",
    description: "Run git status through Termyte policy, memory, and replay ledger.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "termyte.git.diff",
    description: "Run git diff through Termyte. Optionally pass a path.",
    inputSchema: { type: "object", properties: { path: stringSchema, stat: booleanSchema }, additionalProperties: false },
  },
  {
    name: "termyte.git.commit",
    description: "Create a git commit through Termyte. Requires policy approval if configured.",
    inputSchema: { type: "object", properties: { message: stringSchema }, required: ["message"], additionalProperties: false },
  },
  {
    name: "termyte.git.push",
    description: "Run git push through Termyte. Force pushes and protected branches are governed.",
    inputSchema: { type: "object", properties: { remote: stringSchema, branch: stringSchema, force: booleanSchema }, additionalProperties: false },
  },
  {
    name: "termyte.git.reset",
    description: "Run git reset through Termyte. Hard resets are governed.",
    inputSchema: { type: "object", properties: { target: stringSchema, hard: booleanSchema }, additionalProperties: false },
  },
  {
    name: "termyte.fs.read",
    description: "Read a file through Termyte. Secret-looking paths are governed.",
    inputSchema: { type: "object", properties: { path: stringSchema }, required: ["path"], additionalProperties: false },
  },
  {
    name: "termyte.fs.write",
    description: "Write a file through Termyte. Writes are governed and logged.",
    inputSchema: { type: "object", properties: { path: stringSchema, content: stringSchema, append: booleanSchema }, required: ["path", "content"], additionalProperties: false },
  },
  {
    name: "termyte.fs.delete",
    description: "Delete a file or directory through Termyte. Broad or protected deletes are blocked.",
    inputSchema: { type: "object", properties: { path: stringSchema, recursive: booleanSchema }, required: ["path"], additionalProperties: false },
  },
  {
    name: "termyte.shell.run",
    description: "Run an arbitrary shell command through Termyte policy, approvals, memory, and ledger.",
    inputSchema: { type: "object", properties: { command: stringSchema, dryRun: booleanSchema }, required: ["command"], additionalProperties: false },
  },
  {
    name: "termyte.package.install",
    description: "Run npm/pnpm/yarn install through Termyte.",
    inputSchema: { type: "object", properties: { manager: stringSchema, package: stringSchema, dev: booleanSchema }, required: ["package"], additionalProperties: false },
  },
  {
    name: "termyte.package.run",
    description: "Run a package script through Termyte.",
    inputSchema: { type: "object", properties: { manager: stringSchema, script: stringSchema }, required: ["script"], additionalProperties: false },
  },
  {
    name: "termyte.policy.explain",
    description: "Explain the Termyte decision for a command without executing it.",
    inputSchema: { type: "object", properties: { command: stringSchema }, required: ["command"], additionalProperties: false },
  },
  {
    name: "termyte.replay.query",
    description: "Return recent Termyte replay ledger entries.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
  },
  {
    name: "termyte.runtime.prove",
    description: "Run Termyte's deterministic local runtime proof.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

async function callTool(name: string, args: Record<string, unknown>, cwd: string, dbPath: string): Promise<unknown> {
  if (name === "termyte.git.status") {
    return governedCommand("git status --short --branch", cwd, dbPath);
  }
  if (name === "termyte.git.diff") {
    const target = stringArg(args, "path");
    const stat = booleanArg(args, "stat", false);
    return governedCommand(`git diff${stat ? " --stat" : ""}${target ? ` -- ${shellPath(target)}` : ""}`, cwd, dbPath);
  }
  if (name === "termyte.git.commit") {
    return governedCommand(`git commit -m ${shellPath(stringArg(args, "message"))}`, cwd, dbPath);
  }
  if (name === "termyte.git.push") {
    const remote = stringArg(args, "remote", "origin");
    const branch = stringArg(args, "branch");
    const force = booleanArg(args, "force", false);
    return governedCommand(`git push${force ? " --force" : ""} ${remote}${branch ? ` ${branch}` : ""}`, cwd, dbPath);
  }
  if (name === "termyte.git.reset") {
    const target = stringArg(args, "target", "HEAD");
    return governedCommand(`git reset${booleanArg(args, "hard", false) ? " --hard" : ""} ${target}`, cwd, dbPath);
  }
  if (name === "termyte.fs.read") {
    return governedCommand(commandForRead(stringArg(args, "path")), cwd, dbPath);
  }
  if (name === "termyte.fs.write") {
    return governedCommand(commandForWrite(stringArg(args, "path"), stringArg(args, "content"), booleanArg(args, "append", false)), cwd, dbPath);
  }
  if (name === "termyte.fs.delete") {
    return governedCommand(commandForDelete(stringArg(args, "path"), booleanArg(args, "recursive", false)), cwd, dbPath);
  }
  if (name === "termyte.shell.run") {
    return governedCommand(stringArg(args, "command"), cwd, dbPath, booleanArg(args, "dryRun", false));
  }
  if (name === "termyte.package.install") {
    const manager = packageManagerArg(args);
    const pkg = stringArg(args, "package");
    const dev = booleanArg(args, "dev", false);
    return governedCommand(`${manager} install ${dev ? "-D " : ""}${shellPath(pkg)}`, cwd, dbPath);
  }
  if (name === "termyte.package.run") {
    const manager = packageManagerArg(args);
    return governedCommand(`${manager} run ${shellPath(stringArg(args, "script"))}`, cwd, dbPath);
  }
  if (name === "termyte.policy.explain") {
    const inspection = inspectAction(stringArg(args, "command"), cwd, dbPath);
    return {
      command: stringArg(args, "command"),
      finalDecision: inspection.finalDecision,
      semanticId: inspection.action.semanticId,
      reason: inspection.finalReason,
      safeAlternative: inspection.safeAlternative,
      matchedPolicies: inspection.matchedPolicies ?? inspection.policy.matchedPolicies ?? [inspection.policy.matchedRule].filter(Boolean),
      targets: inspection.targets,
      risk: inspection.risk,
      policy: inspection.policy,
      memoryMatches: inspection.memoryMatches,
    };
  }
  if (name === "termyte.replay.query") {
    const db = openDatabase(dbPath).db;
    const records = new Ledger(db).replay();
    return replayEntries(records).slice(-numberArg(args, "limit", 25));
  }
  if (name === "termyte.runtime.prove") {
    return runRuntimeProof({ cwd, dbPath });
  }
  throw new Error(`Unknown Termyte MCP tool: ${name}`);
}

function response(id: JsonRpcId | undefined, result: unknown): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`;
}

function errorResponse(id: JsonRpcId | undefined, code: number, message: string): string {
  return `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`;
}

export async function handleMcpRequest(request: JsonRpcRequest, cwd: string, dbPath: string): Promise<string | null> {
  if (!request.method) {
    return errorResponse(request.id, -32600, "Invalid JSON-RPC request.");
  }
  if (request.method.startsWith("notifications/")) {
    return null;
  }
  if (request.method === "initialize") {
    return response(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "termyte",
        version: "0.3.0",
      },
    });
  }
  if (request.method === "tools/list") {
    return response(request.id, { tools: MCP_TOOLS });
  }
  if (request.method === "tools/call") {
    const params = request.params as ToolCallParams | undefined;
    const name = params?.name;
    if (!name) {
      return errorResponse(request.id, -32602, "Missing tool name.");
    }
    const args = params.arguments ?? {};
    const result = await callTool(name, args, cwd, dbPath);
    return response(request.id, toolText(result));
  }
  return errorResponse(request.id, -32601, `Unsupported MCP method: ${request.method}`);
}

export async function runMcpServer(options: McpServerOptions = {}): Promise<void> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dbPath = options.dbPath ?? defaultDbPath(cwd);
  const input = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const rl = readline.createInterface({ input });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcRequest;
      const output = await handleMcpRequest(parsed, cwd, dbPath);
      if (output) stdout.write(output);
    } catch (error) {
      stderr.write(`Termyte MCP request failed: ${error instanceof Error ? error.message : String(error)}\n`);
      stdout.write(errorResponse(undefined, -32700, "Invalid JSON-RPC message."));
    }
  }
}

export function buildMcpInstallConfig(cwd = process.cwd()): Record<string, unknown> {
  const cliPath = path.resolve(process.argv[1] ?? "termyte");
  const command = process.execPath;
  const args = [cliPath, "mcp", "serve"];
  return {
    mcpServers: {
      termyte: {
        command,
        args,
        env: {
          TERMYTE_WORKSPACE: path.resolve(cwd),
        },
      },
    },
  };
}

export function formatMcpInstall(agent: string, cwd = process.cwd(), json = false): string {
  const config = buildMcpInstallConfig(cwd);
  if (json) {
    return JSON.stringify(config, null, 2);
  }

  const server = (config.mcpServers as { termyte: { command: string; args: string[] } }).termyte;

  const target = agent.toLowerCase();
  const header = target === "claude"
    ? "Claude/Cursor-style MCP configuration"
    : target === "codex"
      ? "Codex MCP configuration"
      : "Generic MCP configuration";

  return [
    `Termyte MCP install helper: ${agent}`,
    "",
    header,
    JSON.stringify(config, null, 2),
    "",
    "Server command:",
    `  ${server.command} ${server.args.map((arg) => JSON.stringify(arg)).join(" ")}`,
    "",
    "After adding the MCP server, ask the agent to use Termyte tools for git, filesystem, shell, package, policy, replay, and runtime proof actions.",
  ].join("\n");
}
