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
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ContextBuilder, renderHybridResults, renderMemory } from "../context/builder.js";
import { buildMemoryExplain, renderMemoryExplain } from "../explain/memory-explain.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { MCP_TOOL_DEFS } from "./tools.js";
import { DocumentStore, type DocumentType, type SparseHit } from "../storage/documents.js";
import {
  validateContextInput,
  validateExplainInput,
  validateFeedbackInput,
  validateNumericIdInput,
  validateSearchInput,
  type RetrievalType,
} from "./schemas.js";
import type { JsonRpcRequest, JsonRpcResponse } from "./types.js";
import { createEmbeddingsProvider } from "../runtime/providers.js";
import { randomUUID } from "node:crypto";

export class TermyteMcpServer {
  private store: Store;
  private search: HybridSearch;
  private contextBuilder: ContextBuilder;
  private embeddings: EmbeddingsProvider;
  private documents: DocumentStore;

  constructor(deps?: { store: Store; embeddings?: EmbeddingsProvider }) {
    const config = deps ? null : loadConfig();
    this.store = deps?.store ?? new Store(config!.dbPath);
    if (deps?.embeddings) this.embeddings = deps.embeddings;
    else if (deps) this.embeddings = new NoOpEmbeddingsProvider();
    else try { this.embeddings = createEmbeddingsProvider(config!.embeddings.model); }
    catch { this.embeddings = new NoOpEmbeddingsProvider(); }
    const fts = new FTSSearch(this.store);
    const vector = new VectorSearch(this.store);
    this.search = new HybridSearch({ fts, vector, embeddings: this.embeddings, feedbackStore: this.store });
    this.contextBuilder = new ContextBuilder(this.store, this.search);
    this.documents = new DocumentStore(this.store.getDB());
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
            serverInfo: { name: "termyte", version: "1.0.3" },
          }};
        case "notifications/initialized":
          return { jsonrpc: "2.0", id, result: {} };
        case "tools/list":
          return { jsonrpc: "2.0", id, result: { tools: MCP_TOOL_DEFS } };
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
      case "termyte.search":
      case "search_memories": {
        const input = validateSearchInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        if (!isCurrentMemorySearchSupported(input.value.type)) {
          const hits = this.searchDocuments(
            input.value.query,
            input.value.type,
            input.value.files,
            input.value.sessionId,
            input.value.limit,
          );
          return textResult(JSON.stringify({
            results: hits.map(documentHitResult),
          }, null, 2));
        }
        const results = await this.search.search({
          query: input.value.query,
          limit: input.value.limit ?? 20,
          repo_id: input.value.repo_id,
          currentFiles: input.value.files,
        });
        if (name === "search_memories") return textResult(renderHybridResults(results));
        return textResult(JSON.stringify({
          results: results.map((r) => ({
            id: `memory:${r.memory.id}`,
            type: "memory",
            score: r.combined_score,
            content: [r.memory.title, r.memory.description].filter(Boolean).join("\n"),
            files: [...r.memory.files_read, ...r.memory.files_modified],
            confidence: r.memory.confidence ?? null,
            importance: r.memory.importance ?? null,
            provenance: [
              ...r.memory.source_trace_ids.map((id) => `trace:${id}`),
              ...r.memory.source_observation_ids.map((id) => `observation:${id}`),
            ],
          })),
        }, null, 2));
      }
      case "termyte.context": {
        const input = validateContextInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        if (!isCurrentMemorySearchSupported(input.value.type)) {
          const startedAt = Date.now();
          const hits = this.searchDocuments(
            input.value.query,
            input.value.type,
            input.value.files,
            input.value.sessionId,
            input.value.limit,
          );
          const markdown = renderDocumentContext(hits, input.value.tokenBudget);
          const episode = input.value.sessionId ? this.store.getActiveEpisode(input.value.sessionId) : null;
          const packet = this.store.recordContextPacket({
            sessionId: input.value.sessionId,
            episodeId: episode?.id,
            repoId: input.value.repo_id ?? "unknown",
            agent: "mcp",
            task: input.value.query,
            tokenBudget: input.value.tokenBudget ?? 4_000,
            estimatedTokens: Math.ceil(markdown.length / 4),
            retrievalMode: "fts-documents",
            latencyMs: Date.now() - startedAt,
            renderedText: markdown,
            candidates: hits.map((hit, index) => ({
              candidateId: hit.document.id,
              kind: documentCandidateKind(hit.document.doc_type),
              sourceId: hit.document.source_id,
              tokenEstimate: Math.ceil(hit.document.content.length / 4),
              selected: true,
              rank: index + 1,
              finalScore: hit.score,
              scoreBreakdown: { sparse_score: hit.score },
              renderedText: hit.document.content,
            })),
          });
          const injectionId = markdown && hits.length > 0 ? randomUUID() : null;
          if (injectionId) this.store.recordContextInjection({
            id: injectionId,
            sessionId: input.value.sessionId,
            repoId: input.value.repo_id,
            query: input.value.query,
            files: input.value.files,
            memoryIds: [],
            surface: "mcp",
            packetId: packet.id,
            deliveryMethod: "mcp",
          });
          return textResult(JSON.stringify({
            markdown,
            selectedIds: hits.map((hit) => hit.document.id),
            estimatedTokens: Math.ceil(markdown.length / 4),
            contextInjectionId: injectionId,
            contextPacketId: packet.id,
          }, null, 2));
        }
        const context = await this.contextBuilder.build({
          repo_id: input.value.repo_id,
          query: input.value.query,
          maxMemories: input.value.limit ?? 50,
          currentFiles: input.value.files,
          sessionId: input.value.sessionId,
          episodeId: input.value.sessionId ? this.store.getActiveEpisode(input.value.sessionId)?.id : undefined,
          surface: "mcp",
          tokenBudget: input.value.tokenBudget,
        });
        return textResult(JSON.stringify({
          markdown: context.text,
          selectedIds: context.memories.map((memory) => `memory:${memory.id}`),
          estimatedTokens: Math.ceil(context.text.length / 4),
          contextInjectionId: context.contextInjectionId,
          contextPacketId: context.contextPacketId,
        }, null, 2));
      }
      case "termyte.get_memory":
      case "get_memory": {
        const input = validateNumericIdInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        const memory = this.store.getMemory(input.value.id);
        if (!memory) return textResult(`(no memory with id ${input.value.id})`, true);
        return textResult(renderMemory(memory));
      }
      case "termyte.get_trace": {
        const input = validateNumericIdInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        const trace = this.store.getTrace(input.value.id);
        if (!trace) return textResult(`(no trace with id ${input.value.id})`, true);
        return textResult(JSON.stringify(trace, null, 2));
      }
      case "termyte.get_observation": {
        const input = validateNumericIdInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        const observation = this.store.getObservation(input.value.id);
        if (!observation) return textResult(`(no observation with id ${input.value.id})`, true);
        return textResult(JSON.stringify(observation, null, 2));
      }
      case "termyte.feedback": {
        const input = validateFeedbackInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        const match = input.value.id.match(/^memory:(\d+)$/);
        const injection = this.store.getContextInjection(input.value.contextInjectionId);
        if (!match || !injection || !injection.memory_ids.includes(Number(match[1]))) {
          return validationErrorResult({
            code: "INVALID_ARGUMENT",
            field: "contextInjectionId",
            message: "id must name a memory present in contextInjectionId",
          });
        }
        const result = this.store.recordMemoryFeedback({
          id: input.value.id,
          event: input.value.event,
          contextInjectionId: input.value.contextInjectionId,
          correctionText: input.value.correctionText,
          source: "mcp",
        });
        if (!result.recorded) {
          return textResult(JSON.stringify({
            accepted: false,
            recorded: false,
            reason: result.reason,
          }, null, 2), true);
        }
        return textResult(JSON.stringify({
          accepted: true,
          recorded: true,
          memoryId: result.memoryId,
          event: input.value.event,
        }, null, 2));
      }
      case "termyte.explain": {
        const input = validateExplainInput(args);
        if (!input.ok) return validationErrorResult(input.error);
        const explanation = buildMemoryExplain(this.store, input.value.id);
        return textResult(JSON.stringify({
          explanation,
          markdown: renderMemoryExplain(explanation),
        }, null, 2));
      }
      case "termyte.health": {
        const health = this.store.getHealthDiagnostics();
        const deadJobs = this.store.getDeadJobs(10);
        return textResult(JSON.stringify({
          database: "ok",
          queue: health.queue,
          oldestPendingAgeMs: health.oldestPendingAgeMs,
          deadLetters: deadJobs.map((j) => ({
            id: j.id, kind: j.kind, subjectType: j.subject_type,
            subjectId: j.subject_id, attempts: j.attempt_count,
            error: j.last_error,
          })),
        }, null, 2));
      }
      case "termyte.stats":
        return textResult(JSON.stringify({
          database: "ok",
          jobs: this.store.getHealthDiagnostics().queue,
          documents: (this.store.getDB().prepare(`SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL`).get() as { c: number }).c,
          retrieval: {
            sqliteVecAvailable: null,
            ftsAvailable: true,
          },
        }, null, 2));
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

  private searchDocuments(
    query: string,
    type: RetrievalType | undefined,
    files: string[] | undefined,
    sessionId: string | undefined,
    limit: number | undefined,
  ): SparseHit[] {
    return this.documents.searchSparse({
      query,
      files,
      sessionId,
      types: type && type !== "all" ? [type as DocumentType] : undefined,
      limit: limit ?? 20,
    });
  }
}

function textResult(text: string, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text }], isError };
}

function validationErrorResult(error: { code: string; message: string; field?: string }): ReturnType<typeof textResult> {
  return textResult(JSON.stringify({ error }, null, 2), true);
}

function isCurrentMemorySearchSupported(type: RetrievalType | undefined): boolean {
  return type === undefined || type === "all" || type === "memory";
}

function documentHitResult(hit: SparseHit): Record<string, unknown> {
  return {
    id: hit.document.id,
    type: hit.document.doc_type,
    score: hit.score,
    content: hit.document.content,
    files: hit.document.files,
    confidence: hit.document.confidence,
    importance: hit.document.importance,
    provenance: [`${hit.document.doc_type}:${hit.document.source_id}`],
  };
}

function documentCandidateKind(type: DocumentType): "evidence" | "observation" | "memory" | "summary" | "episode" {
  return type === "trace" ? "evidence" : type;
}

function renderDocumentContext(hits: SparseHit[], tokenBudget = 4_000): string {
  const maxCharacters = Math.max(0, tokenBudget * 4);
  const sections = hits.map((hit) => [
    `## ${hit.document.id} [${hit.document.doc_type}]`,
    hit.document.content,
    hit.document.files.length > 0 ? `Files: ${hit.document.files.join(", ")}` : "",
  ].filter(Boolean).join("\n"));
  return ["# Termyte Context", ...sections].join("\n\n").slice(0, maxCharacters);
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
