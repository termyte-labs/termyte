import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";
import {
  isMemoryEligible,
  memoryEligibilitySql,
  DEFAULT_ELIGIBLE_MEMORY_STATES,
  ALL_MEMORY_STATES,
} from "../src/retrieval/eligibility.js";
import type { EmbeddingsProvider } from "../src/retrieval/embeddings.js";

class FixedEmbeddings implements EmbeddingsProvider {
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
let embeddings: FixedEmbeddings;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  store.upsertSession("s1", "repo", "r1", "/w");
  embeddings = new FixedEmbeddings();
});

function embedVec(text: string): Float32Array {
  const v = new Float32Array(embeddings.dimensions);
  for (let i = 0; i < text.length; i++) v[i % embeddings.dimensions]! += text.charCodeAt(i);
  return v;
}

function seedMemory(title: string, state = "active"): number {
  const m = store.insertMemory({
    session_id: "s1",
    repo_id: "r1",
    workspace_root: "/w",
    type: "fact",
    title,
    description: "auth token trim",
    files_read: ["src/auth.ts"],
    files_modified: [],
    source_observation_ids: [],
    source_trace_ids: [],
    created_at: Date.now(),
    embedding: null,
  });
  if (state !== "active") store.updateMemoryLifecycleState(m.id, state as never);
  store.updateMemoryEmbedding(m.id, embedVec(title));
  return m.id;
}

const INELIGIBLE_STATES = ["superseded", "conflicted", "deleted", "failed", "stale"];

describe("RET-001 eligibility policy", () => {
  it("default eligible states are exactly active", () => {
    expect([...DEFAULT_ELIGIBLE_MEMORY_STATES]).toEqual(["active"]);
  });

  it("isMemoryEligible excludes invalid states and includes active", () => {
    expect(isMemoryEligible({ lifecycle_state: "active" })).toBe(true);
    for (const s of INELIGIBLE_STATES) expect(isMemoryEligible({ lifecycle_state: s })).toBe(false);
    expect(isMemoryEligible({ lifecycle_state: "active" }, ALL_MEMORY_STATES)).toBe(true);
    expect(isMemoryEligible({ lifecycle_state: "superseded" }, ALL_MEMORY_STATES)).toBe(true);
  });

  it("memoryEligibilitySql emits a bound IN clause", () => {
    const { clause, params } = memoryEligibilitySql("m");
    expect(clause).toBe("m.lifecycle_state IN (?)");
    expect(params).toEqual(["active"]);
  });
});

describe("RET-001 FTS excludes ineligible memories by default", () => {
  it("returns only active memories and honors the override", () => {
    seedMemory("Active auth token memory", "active");
    seedMemory("Superseded auth token memory", "superseded");
    const fts = new FTSSearch(store);
    const def = fts.search({ query: "auth token", limit: 10 });
    expect(def.every((m) => m.lifecycle_state === "active")).toBe(true);
    expect(def.some((m) => m.title.startsWith("Active"))).toBe(true);

    const all = fts.search({ query: "auth token", limit: 10, eligibleStates: ALL_MEMORY_STATES });
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("RET-001 vector search excludes ineligible memories by default", () => {
  it("returns only active memories and honors the override", () => {
    const q = embedVec("auth token");
    seedMemory("Active auth token memory", "active");
    seedMemory("Superseded auth token memory", "superseded");
    const vector = new VectorSearch(store);
    const def = vector.search({ query: q, limit: 10 });
    expect(def.every((r) => r.memory.lifecycle_state === "active")).toBe(true);
    const all = vector.search({ query: q, limit: 10, eligibleStates: ALL_MEMORY_STATES });
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("RET-001 context builder excludes ineligible memories", () => {
  it("no-query recent path returns only active memories", async () => {
    seedMemory("Active one", "active");
    seedMemory("Superseded one", "superseded");
    seedMemory("Deleted one", "deleted");
    const search = new HybridSearch({ fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings });
    const builder = new ContextBuilder(store, search);
    const out = await builder.build({ repo_id: "r1" });
    expect(out.memories.every((m) => m.lifecycle_state === "active")).toBe(true);
    expect(out.memories.length).toBe(1);
  });

  it("query path (hybrid) returns only active memories", async () => {
    seedMemory("Active auth token memory", "active");
    seedMemory("Conflicted auth token memory", "conflicted");
    const search = new HybridSearch({ fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings });
    const builder = new ContextBuilder(store, search);
    const out = await builder.build({ repo_id: "r1", query: "auth token" });
    expect(out.memories.every((m) => m.lifecycle_state === "active")).toBe(true);
  });
});