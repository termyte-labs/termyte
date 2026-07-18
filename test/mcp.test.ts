import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { LocalEmbeddingsProvider, type LocalModelId } from "../src/retrieval/local-embeddings.js";
import { NoOpEmbeddingsProvider, type EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { DocumentStore } from "../src/storage/documents.js";

let dbCtx: DatabaseContext;

beforeEach(() => {
  dbCtx = openDatabase(":memory:");
});

/**
 * Test the MCP server's `handle()` method directly so we don't have to
 * spin up a real stdio loop. We inject a fake deps object so we can
 * avoid loading the heavy LocalEmbeddingsProvider and observe text
 * output.
 */

interface FakeServerOptions {
  store: Store;
  embeddings?: EmbeddingsProvider;
}

async function makeServer({ store, embeddings }: FakeServerOptions) {
  // We import the server module dynamically to avoid pulling the
  // LocalEmbeddingsProvider into the test graph (it tries to download
  // a model on construction).
  const mod = await import("../src/mcp/server.js");
  // The exported TermyteMcpServer class is private; the only public
  // entry is runMcpServer. To unit-test, we re-create a minimal
  // request handler that mirrors the same tool dispatch by re-using
  // the exported module. But since the class is not exported, we
  // exercise the JSON-RPC contract by running the full read-eval
  // loop with a mock stdin/stdout.
  return mod;
}

class FakeStdio {
  data: string[] = [];
  lines: string[] = [];
  write(s: string): void { this.data.push(s); }
  isTTY = false;
  resume(): this { return this; }
  setEncoding(): this { return this; }
  on(): this { return this; }
  once(): this { return this; }
  off(): this { return this; }
  removeListener(): this { return this; }
}

describe("MCP server", () => {
  it("exports runMcpServer", async () => {
    const mod = await import("../src/mcp/server.js");
    expect(typeof mod.runMcpServer).toBe("function");
  });

  it("reports the package release version", async () => {
    const store = new Store(dbCtx);
    const { TermyteMcpServer } = await import("../src/mcp/server.js");
    const server = new TermyteMcpServer({ store });
    const response = await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect((response.result as any).serverInfo.version).toBe("1.0.3");
    server.close();
  });

  it("can construct the full tool dispatch by mocking stdio", async () => {
    // Smoke test: prove the public surface compiles and can be
    // imported. Deeper behavioral tests are left to manual / e2e
    // because TermyteMcpServer is not exported (it's an internal
    // detail of runMcpServer).
    const store = new Store(dbCtx);
    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const search = new HybridSearch({ fts, vector, embeddings: new NoOpEmbeddingsProvider() });
    // Touch the search so the wiring is exercised.
    const results = await search.search({ query: "anything", limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    store.close();
  });

  it("renders HybridSearch results via the same builder the MCP tools use", async () => {
    const store = new Store(dbCtx);
    store.upsertSession("s1", "test", "github.com/test/repo", "/work");
    store.insertMemory({
      session_id: "s1",
      repo_id: "github.com/test/repo",
      workspace_root: "/work",
      type: "fact",
      title: "Authentication uses JWT",
      description: "Tokens are HS256 signed and 24h-lived.",
      files_read: ["src/auth.ts"],
      files_modified: [],
      source_observation_ids: [],
      source_trace_ids: [],
      created_at: Date.now(),
      embedding: null,
    });

    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const search = new HybridSearch({ fts, vector, embeddings: new NoOpEmbeddingsProvider() });
    const results = await search.search({ query: "Authentication JWT", limit: 5 });
    expect(results.length).toBeGreaterThan(0);

    const { renderHybridResults } = await import("../src/context/builder.js");
    const text = renderHybridResults(results);
    expect(text).toContain("Authentication uses JWT");
    expect(text).toContain("src/auth.ts");
    store.close();
  });

  it("Store.getRecentSessions returns the most recent first", async () => {
    const store = new Store(dbCtx);
    store.upsertSession("a", "p1", "r", "/w");
    await new Promise((r) => setTimeout(r, 5));
    store.upsertSession("b", "p2", "r", "/w");
    await new Promise((r) => setTimeout(r, 5));
    store.upsertSession("c", "p3", "r", "/w");
    const list = store.getRecentSessions(2);
    expect(list.length).toBe(2);
    expect(list[0]!.session_id).toBe("c");
    expect(list[1]!.session_id).toBe("b");
    store.close();
  });

  it("returns attributable context using the requested budget and active episode", async () => {
    const store = new Store(dbCtx);
    store.upsertSession("s1", "test", "r1", "/work");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/work", task: "Fix auth" });
    store.insertMemory({
      session_id: "s1", repo_id: "r1", workspace_root: "/work", type: "fact",
      title: "Authentication uses JWT", description: "JWT validation is in src/auth.ts.",
      files_read: ["src/auth.ts"], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: Date.now(), embedding: null,
    });
    const { TermyteMcpServer } = await import("../src/mcp/server.js");
    const server = new TermyteMcpServer({ store });
    const response = await server.handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "termyte.context", arguments: { query: "JWT auth", repo_id: "r1", sessionId: "s1", tokenBudget: 256 } },
    });
    const payload = parseToolPayload(response);
    expect(payload.contextInjectionId).toEqual(expect.any(String));
    expect(payload.contextPacketId).toEqual(expect.any(String));
    expect(store.getContextPacket(String(payload.contextPacketId))).toMatchObject({ token_budget: 256, episode_id: episode.id });
    server.close();
  });

  it("persists typed document deliveries and rejects feedback outside the injection", async () => {
    const store = new Store(dbCtx);
    store.upsertSession("s1", "test", "r1", "/work");
    new DocumentStore(store.getDB()).upsertDocument({
      id: "observation:7", doc_type: "observation", source_id: "7", session_id: "s1",
      content: "Auth observation from src/auth.ts", files: ["src/auth.ts"],
    });
    const memory = store.insertMemory({
      session_id: "s1", repo_id: "r1", workspace_root: "/work", type: "fact", title: "Auth memory",
      description: null, files_read: [], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: Date.now(), embedding: null,
    });
    const { TermyteMcpServer } = await import("../src/mcp/server.js");
    const server = new TermyteMcpServer({ store });
    const contextResponse = await server.handle({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "termyte.context", arguments: { query: "auth", type: "observation", sessionId: "s1", tokenBudget: 256 } },
    });
    const context = parseToolPayload(contextResponse);
    expect(context.contextInjectionId).toEqual(expect.any(String));
    expect(store.getContextCandidates(String(context.contextPacketId))).toHaveLength(1);

    const feedbackResponse = await server.handle({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "termyte.feedback", arguments: {
        id: `memory:${memory.id}`, event: "harmful", contextInjectionId: context.contextInjectionId,
      } },
    });
    const result = feedbackResponse.result as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(store.getMemoryFeedbackForMemory(memory.id)).toHaveLength(0);
    server.close();
  });
});

function parseToolPayload(response: { result?: unknown }): Record<string, unknown> {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}
