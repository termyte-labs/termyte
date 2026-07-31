import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { FTSSearch } from "../src/context/retrieval/fts.js";
import { VectorSearch } from "../src/context/retrieval/vector.js";
import { HybridSearch } from "../src/context/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";

class MockEmbeddings implements import("../src/context/retrieval/embeddings.js").EmbeddingsProvider {
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
  search = new HybridSearch({ fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings, feedbackStore: store });
  builder = new ContextBuilder(store, search);
});

function seedMemory(title: string): number {
  const m = store.insertMemory({
    session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
    title, description: "desc", files_read: ["src/a.ts"], files_modified: [],
    source_observation_ids: [], source_trace_ids: [], created_at: Date.now(), embedding: null,
  });
  store.updateMemoryEmbedding(m.id, new Float32Array([1, 0, 0, 0]));
  return m.id;
}

function getFeedbackEvents(memoryId: number): Array<{ event_type: string; context_injection_id: string | null }> {
  return store.getDB()
    .prepare(`SELECT event_type, context_injection_id FROM memory_feedback WHERE memory_id = ? ORDER BY created_at`)
    .all(memoryId) as Array<{ event_type: string; context_injection_id: string | null }>;
}

describe("FB-001 automatic exposure (shown) recording", () => {
  it("records a shown event for each injected memory with the injection ID", async () => {
    const m1 = seedMemory("Fact A");
    const m2 = seedMemory("Fact B");
    const out = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1" });
    expect(out.memories.length).toBe(2);

    for (const m of out.memories) {
      const events = getFeedbackEvents(m.id);
      expect(events.length).toBe(1);
      expect(events[0]!.event_type).toBe("shown");
      expect(events[0]!.context_injection_id).toBe(out.contextInjectionId);
    }
  });

  it("does not record shown when no memories are injected", async () => {
    const out = await builder.build({ repo_id: "r1" });
    expect(out.memories.length).toBe(0);
    const count = (store.getDB().prepare(`SELECT COUNT(*) c FROM memory_feedback`).get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it("each injection records exactly one shown per memory (no duplicates on re-read)", async () => {
    const m1 = seedMemory("Fact A");
    await builder.build({ repo_id: "r1", surface: "test" });
    await builder.build({ repo_id: "r1", surface: "test" });
    const events = getFeedbackEvents(m1);
    expect(events.length).toBe(2); // one per injection
    expect(events.every((e) => e.event_type === "shown")).toBe(true);
    // Each has a distinct injection ID
    expect(events[0]!.context_injection_id).not.toBe(events[1]!.context_injection_id);
  });

  it("shown events persist the surface as source", async () => {
    seedMemory("Fact A");
    await builder.build({ repo_id: "r1", surface: "mcp" });
    const source = (store.getDB().prepare(`SELECT source FROM memory_feedback LIMIT 1`).get() as { source: string }).source;
    expect(source).toBe("mcp");
  });

  it("explicit used feedback can be associated with the injection ID", async () => {
    seedMemory("Fact A");
    const out = await builder.build({ repo_id: "r1", surface: "hook", sessionId: "s1" });
    const memoryId = out.memories[0]!.id;
    const result = store.recordMemoryFeedback({
      id: `memory:${memoryId}`,
      event: "used",
      contextInjectionId: out.contextInjectionId,
      source: "explicit",
    });
    expect(result.recorded).toBe(true);

    const events = getFeedbackEvents(memoryId);
    expect(events.length).toBe(2);
    expect(events[0]!.event_type).toBe("shown");
    expect(events[1]!.event_type).toBe("used");
    expect(events[1]!.context_injection_id).toBe(out.contextInjectionId);

    // The used event should have incremented the memory's usage_count
    const mem = store.getMemory(memoryId)!;
    expect(mem.usage_count).toBeGreaterThan(0);
  });

  it("abandoned injection (no used event) has only a shown event", async () => {
    seedMemory("Fact A");
    const out = await builder.build({ repo_id: "r1", surface: "test" });
    const memoryId = out.memories[0]!.id;
    const events = getFeedbackEvents(memoryId);
    expect(events.filter((e) => e.event_type === "used")).toHaveLength(0);
    expect(events.filter((e) => e.event_type === "shown")).toHaveLength(1);
  });

  it("shown exposure does not reinforce importance or ranking feedback", async () => {
    const memoryId = seedMemory("Fact A");
    const before = store.getMemory(memoryId)!.importance;
    await builder.build({ repo_id: "r1", surface: "test" });
    expect(store.getMemory(memoryId)!.importance).toBe(before);
    expect(store.getMemoryFeedbackScores([memoryId]).get(memoryId)).toBeUndefined();
  });
});