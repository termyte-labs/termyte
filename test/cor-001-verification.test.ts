import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { MemoryPipeline } from "../src/pipeline/memory-pipeline.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { MockLLM } from "./mock-llm.js";

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
let llm: MockLLM;
let pipeline: MemoryPipeline;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  llm = new MockLLM();
  pipeline = new MemoryPipeline({ store, llm, embeddings: new MockEmbeddings() });
  store.upsertSession("s1", "repo", "r1", "/w");
});

function seedMemory(title: string, confidence = 0.5): number {
  return store.insertMemory({
    session_id: "s1", repo_id: "r1", workspace_root: "/w", type: "fact",
    title, description: "original desc", files_read: ["src/a.ts"], files_modified: [],
    source_observation_ids: [], source_trace_ids: [], created_at: Date.now(), embedding: null,
  }).id;
}

describe("COR-001 verification and correction jobs", () => {
  it("creates a grounded replacement and supersedes the original when correction text is provided", async () => {
    const originalId = seedMemory("Old fact", 0.5);
    store.recordMemoryFeedback({
      id: `memory:${originalId}`,
      event: "corrected",
      correctionText: "The correct approach is to validate before parsing.",
      source: "mcp",
    });

    // The feedback recording enqueued a verify_memory job — drain it.
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const memories = store.getRecentMemories(10);
    const superseded = memories.find((m) => m.id === originalId);
    const replacement = memories.find((m) => m.lifecycle_state === "active" && m.id !== originalId);

    expect(superseded!.lifecycle_state).toBe("superseded");
    expect(superseded!.superseded_by).toBe(replacement!.id);
    expect(replacement).toBeTruthy();
    expect(replacement!.title).toContain("Corrected: Old fact");
    expect(replacement!.description).toContain("validate before parsing");

    // Edge link exists
    const edges = store.getMemoryEdges(replacement!.id);
    expect(edges.some((e) => e.edge_type === "supersedes" && e.target_memory_id === originalId)).toBe(true);

    // Old document is soft-deleted (if it existed)
    const oldDoc = store.getDB().prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(`memory:${originalId}`) as { deleted_at: number | null } | undefined;
    if (oldDoc) expect(oldDoc.deleted_at).not.toBeNull();

    // New document is active
    const newDoc = store.getDB().prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(`memory:${replacement!.id}`) as { deleted_at: number | null };
    expect(newDoc.deleted_at).toBeNull();
  });

  it("marks conflicted without creating a replacement when no correction text is given", async () => {
    const originalId = seedMemory("Contested fact", 0.5);
    store.recordMemoryFeedback({
      id: `memory:${originalId}`,
      event: "corrected",
      source: "mcp",
    });

    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const mem = store.getMemory(originalId)!;
    expect(mem.lifecycle_state).toBe("conflicted");
    expect(store.getRecentMemories(10).filter((m) => m.lifecycle_state === "active")).toHaveLength(0);
  });

  it("is idempotent: re-running verify on a superseded memory does nothing", async () => {
    const originalId = seedMemory("Old fact");
    store.recordMemoryFeedback({
      id: `memory:${originalId}`,
      event: "corrected",
      correctionText: "The correct way.",
      source: "mcp",
    });
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const beforeCount = (store.getDB().prepare(`SELECT COUNT(*) c FROM memories`).get() as { c: number }).c;
    const beforeEdges = (store.getDB().prepare(`SELECT COUNT(*) c FROM memory_edges`).get() as { c: number }).c;

    // Re-enqueue and run again
    store.getDB().prepare(
      `INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at)
       VALUES ('verify-rerun','verify_memory','memory',?,'pending',0,5,0,0,0)`,
    ).run(originalId);
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const afterCount = (store.getDB().prepare(`SELECT COUNT(*) c FROM memories`).get() as { c: number }).c;
    const afterEdges = (store.getDB().prepare(`SELECT COUNT(*) c FROM memory_edges`).get() as { c: number }).c;
    expect(afterCount).toBe(beforeCount);
    expect(afterEdges).toBe(beforeEdges);
  });

  it("correction feedback is persisted with correction_text in memory_feedback", () => {
    const originalId = seedMemory("Test fact");
    store.recordMemoryFeedback({
      id: `memory:${originalId}`,
      event: "corrected",
      correctionText: "Use HMAC not plain hash.",
      source: "mcp",
    });
    const row = store.getDB().prepare(
      `SELECT event_type, correction_text FROM memory_feedback WHERE memory_id = ? AND event_type = 'corrected'`,
    ).get(originalId) as { event_type: string; correction_text: string | null };
    expect(row.event_type).toBe("corrected");
    expect(row.correction_text).toBe("Use HMAC not plain hash.");
  });

  it("insufficient evidence: conflicted memories are excluded from default retrieval", async () => {
    const originalId = seedMemory("Contested fact");
    store.recordMemoryFeedback({
      id: `memory:${originalId}`,
      event: "corrected",
      source: "mcp",
    });
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const fts = new FTSSearch(store);
    const def = fts.search({ query: "contested", limit: 10 });
    expect(def.length).toBe(0);
  });
});