import { describe, expect, it } from "vitest";
import { MemoryVecIndex } from "../src/indexing/memory-vec-index.js";
import { Store } from "../src/storage/store.js";
import { VectorSearch } from "../src/retrieval/vector.js";

describe("active sqlite-vec memory retrieval", () => {
  it("indexes memory embeddings and returns nearest cosine matches", () => {
    const store = new Store(":memory:");
    const index = new MemoryVecIndex(store.getDB(), 4);
    if (!index.ensureSchema()) {
      store.close();
      return;
    }
    index.upsert(1, new Float32Array([1, 0, 0, 0]));
    index.upsert(2, new Float32Array([0, 1, 0, 0]));
    const results = index.search(new Float32Array([1, 0, 0, 0]), 2);
    expect(results.map((result) => result.memoryId)).toEqual([1, 2]);
    expect(results[0]!.score).toBeCloseTo(1, 5);
    store.close();
  });

  it("preserves an explicit unavailable fallback", () => {
    const store = new Store(":memory:");
    const index = new MemoryVecIndex(store.getDB(), 4, true);
    expect(index.ensureSchema()).toBe(false);
    expect(index.search(new Float32Array(4), 5)).toEqual([]);
    store.close();
  });

  it("is populated by Store writes and consumed by active VectorSearch", () => {
    const store = new Store(":memory:");
    store.upsertSession("s1", "test", "repo", "/repo");
    const first = store.insertMemory({
      session_id: "s1", repo_id: "repo", workspace_root: "/repo", type: "fact",
      title: "first", description: "first", files_read: [], files_modified: [],
      source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
    });
    const second = store.insertMemory({
      session_id: "s1", repo_id: "repo", workspace_root: "/repo", type: "fact",
      title: "second", description: "second", files_read: [], files_modified: [],
      source_observation_ids: [], source_trace_ids: [], created_at: 2, embedding: null,
    });
    store.updateMemoryEmbedding(first.id, new Float32Array([1, 0, 0, 0]));
    store.updateMemoryEmbedding(second.id, new Float32Array([0, 1, 0, 0]));
    if (!store.isMemoryVectorIndexAvailable(4)) {
      store.close();
      return;
    }
    const count = store.getDB().prepare(`SELECT COUNT(*) AS count FROM memory_vec_4`).get() as { count: number };
    expect(count.count).toBe(2);
    const results = new VectorSearch(store).search({ query: new Float32Array([1, 0, 0, 0]), repo_id: "repo" });
    expect(results[0]!.memory.id).toBe(first.id);
    store.close();
  });
});
