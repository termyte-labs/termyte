/**
 * Termyte MCP server.
 *
 * Exposes the corpus to any MCP-capable IDE (Copilot CLI, Antigravity,
 * Goose, Roo, Warp). The server speaks JSON-RPC 2.0 over stdio and
 * implements the `initialize` / `tools/list` / `tools/call` methods.
 *
 * Tools:
 *   - search_memories  { query, limit?, repo_id?, currentFiles? }
 *   - get_memory       { id }
 *   - get_recent_sessions { limit? }
 *   - get_session      { session_id }
 *   - get_observations_for_session { session_id, limit? }
 *
 * The server is intentionally synchronous from the agent's perspective:
 * tools return text content blocks. Errors become `isError: true`
 * results so the IDE can surface them to the model.
 */
import { loadConfig } from "../cli/config.js";
import { Store } from "../storage/store.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { renderHybridResults, renderMemory } from "../context/builder.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "search_memories",
    description: "Search the termyte memory corpus. Returns a hybrid FTS + vector ranked list of memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
        repo_id: { type: "string" },
        currentFiles: { type: "array", items: { type: "string" } },
      },
      required: ["query"],
    },
  },
  {
    name: "get_memory",
    description: "Fetch a single memory row by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "get_recent_sessions",
    description: "List the most recent sessions, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "get_session",
    description: "Get a session by id (includes summary if available).",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "get_observations_for_session",
    description: "List observations extracted during a session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["session_id"],
    },
  },
];

class TermyteMcpServer {
  private store: Store;
  private search: HybridSearch;
  private embeddings: EmbeddingsProvider;

  constructor() {
    const config = loadConfig();
    this.store = new Store(config.dbPath);
    try {
      this.embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
    } catch {
      this.embeddings = new NoOpEmbeddingsProvider();
    }
    const fts = new FTSSearch(this.store);
    const vector = new VectorSearch(this.store);
    this.search = new HybridSearch({ fts, vector, embeddings: this.embeddings });
  }

  close(): void { this.store.close(); }

  async handle(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case "initialize":
          return { jsonrpc: "2.0", id, result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "termyte", version: "0.1.0" },
          }};
        case "notifications/initialized":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
        case "tools/call": {
          const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const result = await this.callTool(params.name ?? "", params.arguments ?? {});
          return { jsonrpc: "2.0", id, result };
        }
        case "ping":
          return { jsonrpc: "2.0", id, result: {} };
        default:
          return {
            jsonrpc: "2.0", id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      return {
        jsonrpc: "2.0", id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "search_memories": {
        const query = String(args["query"] ?? "");
        if (!query) return textResult("(missing required argument: query)");
        const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
        const repo_id = typeof args["repo_id"] === "string" ? args["repo_id"] : undefined;
        const currentFiles = Array.isArray(args["currentFiles"])
          ? (args["currentFiles"] as unknown[]).filter((f): f is string => typeof f === "string")
          : undefined;
        const results = await this.search.search({ query, limit, repo_id, currentFiles });
        return textResult(renderHybridResults(results));
      }
      case "get_memory": {
        const id = Number(args["id"]);
        if (!Number.isFinite(id)) return textResult("(missing or invalid id)", true);
        const memory = this.store.getMemory(id);
        if (!memory) return textResult(`(no memory with id ${id})`, true);
        return textResult(renderMemory(memory));
      }
      case "get_recent_sessions": {
        const limit = typeof args["limit"] === "number" ? args["limit"] : 20;
        const sessions = this.store.getRecentSessions(limit);
        const lines = sessions.map((s) =>
          `${s.session_id}  ${s.project}  ${s.repo_id ?? "?"}  ${s.ended_at ? "ended" : "active"}  ${new Date(s.started_at).toISOString()}`);
        return textResult(lines.length === 0 ? "(no sessions)" : lines.join("\n"));
      }
      case "get_session": {
        const sid = String(args["session_id"] ?? "");
        if (!sid) return textResult("(missing session_id)", true);
        const session = this.store.getSession(sid);
        if (!session) return textResult(`(no session with id ${sid})`, true);
        const summary = this.store.getSummary(sid);
        const parts: string[] = [];
        parts.push(`Session: ${session.session_id}`);
        parts.push(`Project: ${session.project}`);
        parts.push(`Repo: ${session.repo_id ?? "(unknown)"}`);
        parts.push(`Workspace: ${session.workspace_root ?? "(unknown)"}`);
        parts.push(`Started: ${new Date(session.started_at).toISOString()}`);
        if (session.ended_at) parts.push(`Ended: ${new Date(session.ended_at).toISOString()}`);
        if (summary?.summary) {
          parts.push("");
          parts.push("Summary:");
          parts.push(summary.summary);
        }
        return textResult(parts.join("\n"));
      }
      case "get_observations_for_session": {
        const sid = String(args["session_id"] ?? "");
        if (!sid) return textResult("(missing session_id)", true);
        const limit = typeof args["limit"] === "number" ? args["limit"] : 100;
        const obs = this.store.getObservationsForSession(sid, limit);
        if (obs.length === 0) return textResult("(no observations)");
        const lines = obs.map((o) => `#${o.id} [${o.type}] ${o.title}${o.description ? " — " + o.description.split("\n")[0] : ""}`);
        return textResult(lines.join("\n"));
      }
      default:
        return textResult(`(unknown tool: ${name})`, true);
    }
  }
}

function textResult(text: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text }], isError };
}

/** Read newline-delimited JSON-RPC requests from a single line per
 *  request, as the MCP spec requires. */
async function readRequests(input: NodeJS.ReadableStream, emit: (line: string) => void): Promise<void> {
  const rl = require("node:readline").createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) emit(line);
  }
}

export async function runMcpServer(): Promise<void> {
  const server = new TermyteMcpServer();
  try {
    await readRequests(process.stdin, async (line) => {
      let req: JsonRpcRequest;
      try { req = JSON.parse(line) as JsonRpcRequest; }
      catch { return; /* ignore malformed */ }
      const res = await server.handle(req);
      // Notifications have no id and expect no response.
      if (res.id === null) return;
      process.stdout.write(JSON.stringify(res) + "\n");
    });
  } finally {
    server.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMcpServer().catch((err) => {
    process.stderr.write(`termyte-mcp: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
