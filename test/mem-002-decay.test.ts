import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { MemoryPipeline } from "../src/pipeline/memory-pipeline.js";
import { memoryDecayScore, nextMemoryStateAfterDecay } from "../src/lifecycle/decay.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { ALL_MEMORY_STATES } from "../src/retrieval/eligibility.js";
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
});

function seedMemory(opts: {
  title?: string;
  created_at?: number;
  importance?: number;
  confidence?: number;
  usage_count?: number;
  last_accessed_at?: number | null;
  repo_id?: string;
}): number {
  const rid = opts.repo_id ?? "r1";
  store.upsertSession("s1", "repo", rid, "/w");
  const id = store.insertMemory({
    session_id: "s1",
    repo_id: rid,
    workspace_root: "/w",
    type: "fact",
    title: opts.title ?? "Test memory",
    description: "desc",
    files_read: [],
    files_modified: [],
    source_observation_ids: [],
    source_trace_ids: [],
    created_at: opts.created_at ?? Date.now(),
    embedding: null,
  }).id;
  store.getDB().prepare(
    `UPDATE memories SET importance = ?, confidence = ?, usage_count = ?, last_accessed_at = ? WHERE id = ?`,
  ).run(
    opts.importance ?? 0.5,
    opts.confidence ?? 0.5,
    opts.usage_count ?? 0,
    opts.last_accessed_at ?? null,
    id,
  );
  return id;
}

describe("MEM-002 decay helper", () => {
  it("returns a lower score for old, unused, low-importance memories", () => {
    const now = Date.now();
    const oldScore = memoryDecayScore({
      id: 1, type: "fact", state: "active", importance: 0.1, confidence: 0.3,
      usage_count: 0, created_at: now - 200 * 86_400_000, updated_at: null,
    }, now);
    const freshScore = memoryDecayScore({
      id: 2, type: "fact", state: "active", importance: 0.8, confidence: 0.9,
      usage_count: 10, created_at: now, updated_at: now,
    }, now);
    expect(oldScore).toBeLessThan(0.22);
    expect(freshScore).toBeGreaterThan(0.22);
  });

  it("nextMemoryStateAfterDecay transitions to stale below the threshold", () => {
    expect(nextMemoryStateAfterDecay({ state: "active" } as any, 0.15)).toBe("stale");
    expect(nextMemoryStateAfterDecay({ state: "active" } as any, 0.50)).toBe("active");
    expect(nextMemoryStateAfterDecay({ state: "deleted" } as any, 0.10)).toBe("deleted");
    expect(nextMemoryStateAfterDecay({ state: "superseded" } as any, 0.10)).toBe("superseded");
  });
});

describe("MEM-002 decay_memories handler", () => {
  it("transitions old active memories to stale and persists decayed_score", async () => {
    const now = Date.now();
    const oldId = seedMemory({ created_at: now - 200 * 86_400_000, importance: 0.1, confidence: 0.3 });
    const freshId = seedMemory({ created_at: now, importance: 0.8, usage_count: 5, last_accessed_at: now });

    store.getDB().prepare(
      `INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at)
       VALUES ('decay-test','decay_memories','memory','r1','pending',0,5,0,0,0)`,
    ).run();
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    const oldMem = store.getMemory(oldId)!;
    const freshMem = store.getMemory(freshId)!;
    expect(oldMem.lifecycle_state).toBe("stale");
    expect(oldMem.decayed_score).toBeLessThan(0.22);
    expect(freshMem.lifecycle_state).toBe("active");
    expect(freshMem.decayed_score).toBeGreaterThan(0.22);
  });

  it("is idempotent: re-running does not re-transition stale memories", async () => {
    const now = Date.now();
    const oldId = seedMemory({ created_at: now - 200 * 86_400_000, importance: 0.1, confidence: 0.3 });

    store.getDB().prepare(
      `INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at)
       VALUES ('decay-1','decay_memories','memory','r1','pending',0,5,0,0,0)`,
    ).run();
    await pipeline.runUntilIdle("w", { maxJobs: 5 });
    expect(store.getMemory(oldId)!.lifecycle_state).toBe("stale");

    // Re-enqueue (different id) and run again
    store.getDB().prepare(
      `INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at)
       VALUES ('decay-2','decay_memories','memory','r1','pending',0,5,0,0,0)`,
    ).run();
    await pipeline.runUntilIdle("w", { maxJobs: 5 });
    expect(store.getMemory(oldId)!.lifecycle_state).toBe("stale");
  });

  it("does not touch superseded or deleted memories", async () => {
    const now = Date.now();
    const winnerId = seedMemory({ created_at: now, importance: 0.9, title: "Winner" });
    const supId = seedMemory({ created_at: now - 200 * 86_400_000, importance: 0.1, title: "Superseded" });
    store.markMemorySuperseded(supId, winnerId);

    store.getDB().prepare(
      `INSERT OR IGNORE INTO jobs (id,kind,subject_type,subject_id,state,attempt_count,max_attempts,next_run_at,created_at,updated_at)
       VALUES ('decay-skip','decay_memories','memory','r1','pending',0,5,0,0,0)`,
    ).run();
    await pipeline.runUntilIdle("w", { maxJobs: 5 });

    expect(store.getMemory(supId)!.lifecycle_state).toBe("superseded");
    expect(store.getMemory(winnerId)!.lifecycle_state).toBe("active");
  });
});

describe("MEM-002 reinforcement recovers from stale", () => {
  it("reinforceMemory restores stale to active and updates usage", () => {
    const now = Date.now();
    const id = seedMemory({ created_at: now - 200 * 86_400_000, importance: 0.1 });
    store.updateMemoryLifecycleState(id, "stale");
    expect(store.getMemory(id)!.lifecycle_state).toBe("stale");

    store.reinforceMemory(id, now);

    const mem = store.getMemory(id)!;
    expect(mem.lifecycle_state).toBe("active");
    expect(mem.state).toBe("active");
    expect(mem.usage_count).toBe(1);
    expect(mem.last_reinforced_at).toBe(now);
    expect(mem.last_accessed_at).toBe(now);
  });

  it("reinforceMemory is safe on already-active memories (idempotent increment)", () => {
    const id = seedMemory({ importance: 0.8, usage_count: 3 });
    store.reinforceMemory(id);
    const mem = store.getMemory(id)!;
    expect(mem.lifecycle_state).toBe("active");
    expect(mem.usage_count).toBe(4);
  });
});

describe("MEM-002 stale memories excluded from default retrieval", () => {
  it("stale memories are not returned by default but appear with --all-states", () => {
    const now = Date.now();
    seedMemory({ created_at: now, importance: 0.8, title: "Active fact" });
    const staleId = seedMemory({ created_at: now - 200 * 86_400_000, importance: 0.1, title: "Old fact" });
    store.updateMemoryLifecycleState(staleId, "stale");

    const fts = new FTSSearch(store);
    const def = fts.search({ query: "fact", limit: 10 });
    expect(def.every((m) => m.lifecycle_state === "active")).toBe(true);
    const all = fts.search({ query: "fact", limit: 10, eligibleStates: ALL_MEMORY_STATES as readonly string[] });
    expect(all.some((m) => m.lifecycle_state === "stale")).toBe(true);
  });
});