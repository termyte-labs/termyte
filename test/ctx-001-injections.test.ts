import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";

class MockEmbeddings implements import("../src/retrieval/embeddings.js").EmbeddingsProvider {
  readonly dimensions = 4;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) v[i % this.dimensions]! += text.charCodeAt(i);
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

let ctx: DatabaseContext;
let store: Store;
let embeddings: MockEmbeddings;
let search: HybridSearch;
let builder: ContextBuilder;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  store.upsertSession("s1", "repo", "r1", "/w");
  embeddings = new MockEmbeddings();
  search = new HybridSearch({ fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings });
  builder = new ContextBuilder(store, search);
});

function seedMemory(title: string, desc: string): number {
  const m = store.insertMemory({
    session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
    title, description: desc, files_read: ["src/a.ts"], files_modified: [],
    source_observation_ids: [], source_trace_ids: [], created_at: Date.now(), embedding: null,
  });
  store.updateMemoryEmbedding(m.id, embeddings.embedSync ? embeddings.embedSync(title) : new Float32Array(4));
  return m.id;
}

describe("CTX-001 context injection persistence", () => {
  it("returns a non-null contextInjectionId", async () => {
    seedMemory("Active fact", "important thing");
    const out = await builder.build({ repo_id: "r1", surface: "test" });
    expect(out.contextInjectionId).toBeTruthy();
    expect(typeof out.contextInjectionId).toBe("string");
    expect(out.contextInjectionId.length).toBeGreaterThan(0);
  });

  it("renders compact experience cards with an explicit detail path", async () => {
    const id = seedMemory("Compact fact", "This is a detailed explanation for later inspection.");
    const out = await builder.build({ repo_id: "r1", query: "compact fact", surface: "test" });
    expect(out.text).toContain(`memory:${id}`);
    expect(out.text).toContain(`termyte memory ${id}`);
  });

  it("persists the injection with memory IDs, query, repo, and surface", async () => {
    seedMemory("Fact A", "desc a");
    seedMemory("Fact B", "desc b");
    const out = await builder.build({ repo_id: "r1", query: "fact", surface: "mcp", sessionId: "s1", currentFiles: ["src/a.ts"] });
    const record = store.getContextInjection(out.contextInjectionId);
    expect(record).not.toBeNull();
    expect(record!.surface).toBe("mcp");
    expect(record!.repo_id).toBe("r1");
    expect(record!.session_id).toBe("s1");
    expect(record!.query).toBe("fact");
    expect(record!.files).toEqual(["src/a.ts"]);
    expect(record!.memory_ids.length).toBeGreaterThan(0);
    const items = store.getContextInjectionItems(out.contextInjectionId);
    expect(items).toHaveLength(record!.memory_ids.length);
    expect(items[0]!.rank).toBe(1);
    expect(items[0]!.score).toBeGreaterThan(0);
    expect(items[0]!.rendered_text).toContain("Fact");
    expect(items[0]!.score_breakdown.final_score).toBe(items[0]!.score);
    expect(items[0]!.score_breakdown.base_score).toBeGreaterThan(0);
  });

  it("each build call produces a unique injection ID", async () => {
    seedMemory("Unique fact", "desc");
    const out1 = await builder.build({ repo_id: "r1", surface: "test" });
    const out2 = await builder.build({ repo_id: "r1", surface: "test" });
    expect(out1.contextInjectionId).not.toBe(out2.contextInjectionId);
  });

  it("injection is retrievable by ID for attribution", async () => {
    seedMemory("Attribution fact", "desc");
    const out = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1" });
    const record = store.getContextInjection(out.contextInjectionId);
    expect(record!.memory_ids).toEqual(out.memories.map((m) => m.id));
  });

  it("returns null for a non-existent injection ID", () => {
    expect(store.getContextInjection("nonexistent")).toBeNull();
  });

  it("migration creates context_injections table with indexes", () => {
    const table = store.getDB().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='context_injections'`).get();
    expect(table).toBeTruthy();
    const indexes = store.getDB().prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_context_injections%'`).all() as Array<{ name: string }>;
    expect(indexes.length).toBeGreaterThanOrEqual(3);
    const itemsTable = store.getDB().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='context_injection_items'`).get();
    expect(itemsTable).toBeTruthy();
  });
});
