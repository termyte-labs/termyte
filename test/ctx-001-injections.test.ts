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
    expect(out.text).toContain(`ID: memory:${id}`);
    expect(out.text).not.toContain("termyte memory");
  });

  it("persists the injection with memory IDs, query, repo, and surface", async () => {
    seedMemory("Fact A", "desc a");
    seedMemory("Fact B", "desc b");
    const out = await builder.build({ repo_id: "r1", query: "fact", surface: "mcp", sessionId: "s1", currentFiles: ["src/a.ts"] });
    const record = store.getContextInjection(out.contextInjectionId!);
    expect(record).not.toBeNull();
    expect(record!.surface).toBe("mcp");
    expect(record!.repo_id).toBe("r1");
    expect(record!.session_id).toBe("s1");
    expect(record!.query).toBe("fact");
    expect(record!.files).toEqual(["src/a.ts"]);
    expect(record!.memory_ids.length).toBeGreaterThan(0);
    const items = store.getContextInjectionItems(out.contextInjectionId!);
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
    const record = store.getContextInjection(out.contextInjectionId!);
    expect(record!.memory_ids).toEqual(out.memories.map((m) => m.id));
  });

  it("resolves the latest injection through its exact episode packet", async () => {
    seedMemory("Episode attribution", "desc");
    const first = store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/w", task: "First" });
    const firstBuild = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1", episodeId: first.id });
    const second = store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/w", task: "Second" });
    const olderSecondBuild = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1", episodeId: second.id });
    const latestSecondBuild = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1", episodeId: second.id });

    expect(store.getLatestContextInjectionForEpisode(first.id)?.id).toBe(firstBuild.contextInjectionId);
    expect(store.getLatestContextInjectionForEpisode(second.id)?.id).toBe(latestSecondBuild.contextInjectionId);
    expect(store.getLatestContextInjectionForEpisode(second.id)?.id).not.toBe(olderSecondBuild.contextInjectionId);
  });

  it("returns null for a non-existent injection ID", () => {
    expect(store.getContextInjection("nonexistent")).toBeNull();
  });

  it("persists the packet but not an injection when the compiler abstains", async () => {
    const id = seedMemory("Package validation", "Run npm pack before release.");
    const out = await builder.build({ repo_id: "r1", query: "ZZZ_NO_MATCH", surface: "hook" });
    expect(id).toBeGreaterThan(0);
    expect(out.text).toBe("");
    expect(out.contextInjectionId).toBeNull();
    expect(store.getContextPacket(out.contextPacketId)).not.toBeNull();
    const count = store.getDB().prepare("SELECT COUNT(*) AS count FROM context_injections").get() as { count: number };
    expect(count.count).toBe(0);
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
