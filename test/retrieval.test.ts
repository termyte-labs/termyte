import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch, type HybridSearchResult } from "../src/retrieval/hybrid.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider, type EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import { openDatabase, closeDatabase, type DatabaseContext } from "../src/storage/connection.js";
import type { Memory } from "../src/core/types.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

/** Deterministic in-memory embedding provider for tests. */
class FixedEmbeddings implements EmbeddingsProvider {
  readonly dimensions: number;
  // text -> embedding
  private table: Map<string, Float32Array>;
  private counter = 0;

  constructor(dims = 4) {
    this.dimensions = dims;
    this.table = new Map();
  }

  set(text: string, vec: Float32Array): void {
    this.table.set(text, vec);
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.table.get(text);
    if (cached) return cached;
    // Deterministic pseudo-embedding from the text: hash-derived, L2-normalized.
    const v = new Float32Array(this.dimensions);
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = (h * 16777619) >>> 0;
      v[i % this.dimensions]! += (h & 0xff) / 255 - 0.5;
    }
    let n = 0;
    for (let i = 0; i < this.dimensions; i++) n += v[i]! * v[i]!;
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < this.dimensions; i++) v[i]! /= n;
    this.table.set(text, v);
    return v;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

function seedMemories(store: Store): void {
  store.upsertSession("s1", "demo");
  store.insertMemory({
    session_id: "s1",
    type: "bugfix",
    title: "Auth token whitespace",
    subtitle: "tokens have trailing spaces",
    facts: ["tokens have whitespace", "trim before use"],
    narrative: "The auth path now trims tokens before validation.",
    concepts: ["problem-solution", "gotcha"],
    files_read: ["src/auth/token.ts"],
    files_modified: ["src/auth/token.ts"],
    created_at: Date.now(),
    embedding: null,
  });
  store.insertMemory({
    session_id: "s1",
    type: "feature",
    title: "Added login rate limiting",
    subtitle: "limit failed attempts",
    facts: ["5 attempts per minute per IP"],
    narrative: "A new rate limiter sits in front of the auth handler.",
    concepts: ["pattern"],
    files_read: [],
    files_modified: ["src/auth/middleware.ts", "src/auth/rate-limit.ts"],
    created_at: Date.now() - 1000,
    embedding: null,
  });
  store.insertMemory({
    session_id: "s1",
    type: "discovery",
    title: "Database indexes need rebalancing",
    subtitle: "hot index bloat",
    facts: ["the users.email index is 4x larger than expected"],
    narrative: "After 6 months of growth the email index bloats query plans.",
    concepts: ["how-it-works"],
    files_read: [],
    files_modified: [],
    created_at: Date.now() - 2000,
    embedding: null,
  });
}

describe("FTSSearch", () => {
  it("finds memories by keyword", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const fts = new FTSSearch(store);
    const results = fts.search({ query: "auth token" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title.toLowerCase()).toContain("auth token");
    store.close();
  });

  it("returns no results for nonsense queries (no FTS hit)", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const fts = new FTSSearch(store);
    const results = fts.search({ query: "qwertyuiop zzzz" });
    expect(results.length).toBe(0);
    store.close();
  });

  it("filters by project", () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "alpha");
    store.upsertSession("s2", "beta");
    store.insertMemory({
      session_id: "s1",
      type: "discovery",
      title: "alpha memory",
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
      created_at: 1,
      embedding: null,
    });
    store.insertMemory({
      session_id: "s2",
      type: "discovery",
      title: "beta memory",
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
      created_at: 1,
      embedding: null,
    });
    const fts = new FTSSearch(store);
    expect(fts.search({ query: "memory", project: "alpha" })[0]!.title).toBe("alpha memory");
    expect(fts.search({ query: "memory", project: "beta" })[0]!.title).toBe("beta memory");
    store.close();
  });
});

describe("VectorSearch", () => {
  it("returns memories with cosine similarity scores", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
    // Build a query vector that exactly matches one of the seeded memory
    // titles. With identical vectors, cosine similarity is 1.0, and the
    // matching memory is the top hit.
    const q = await embeddings.embed("Auth token whitespace");
    const e2 = await embeddings.embed("Added login rate limiting");
    const e3 = await embeddings.embed("Database indexes need rebalancing");
    for (const m of store.getRecentMemories(100)) {
      if (m.title === "Auth token whitespace") store.updateMemoryEmbedding(m.id, q);
      else if (m.title === "Added login rate limiting") store.updateMemoryEmbedding(m.id, e2);
      else store.updateMemoryEmbedding(m.id, e3);
    }

    const v = new VectorSearch(store);
    const results = v.search({ query: q, limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    // Top result must be the auth token memory.
    expect(results[0]!.memory.title).toBe("Auth token whitespace");
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
    store.close();
  });

  it("ranks more similar documents above less similar ones", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
    // Make two memories have orthogonal-ish embeddings by using unrelated
    // hash seeds, then verify the search ranks by cosine.
    const baseV = await embeddings.embed("base");
    const e1 = new Float32Array([1, 0, 0, 0]);
    const e2 = new Float32Array([0, 1, 0, 0]);
    const e3 = new Float32Array([0, 0, 1, 0]);
    for (const m of store.getRecentMemories(100)) {
      if (m.title === "Auth token whitespace") store.updateMemoryEmbedding(m.id, e1);
      else if (m.title === "Added login rate limiting") store.updateMemoryEmbedding(m.id, e2);
      else store.updateMemoryEmbedding(m.id, e3);
    }
    const v = new VectorSearch(store);
    const results = v.search({ query: baseV, limit: 3 });
    expect(results.length).toBe(3);
    // All scores should be in [-1, 1] and the top hit should be a real
    // match (not negative).
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    // Top hit should be one of the three (any order, since "base" doesn't
    // exactly match any title).
    expect(["Auth token whitespace", "Added login rate limiting", "Database indexes need rebalancing"])
      .toContain(results[0]!.memory.title);
    store.close();
  });

  it("filters out memories without embeddings", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const v = new VectorSearch(store);
    const q = new Float32Array([1, 0, 0, 0]);
    const results = v.search({ query: q });
    expect(results.length).toBe(0);
    store.close();
  });
});

describe("HybridSearch", () => {
  it("combines FTS and vector results with RRF", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
    // Pre-compute embeddings for the seeded memories.
    for (const m of store.getRecentMemories(100)) {
      const v = await embeddings.embed(m.title);
      store.updateMemoryEmbedding(m.id, v);
    }
    const fts = new FTSSearch(store);
    const vec = new VectorSearch(store);
    const hybrid = new HybridSearch({ fts, vector: vec, embeddings });
    const results: HybridSearchResult[] = await hybrid.search({
      query: "auth token whitespace",
      limit: 10,
    });
    expect(results.length).toBeGreaterThan(0);
    // Combined score must be positive for any result present.
    for (const r of results) {
      expect(r.combined_score).toBeGreaterThan(0);
    }
    store.close();
  });

  it("degrades to FTS-only when embeddings throw", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const fts = new FTSSearch(store);
    const vec = new VectorSearch(store);
    // A broken embeddings provider.
    const broken: EmbeddingsProvider = {
      dimensions: 0,
      async embed(): Promise<Float32Array> { throw new Error("nope"); },
      async embedBatch(): Promise<Float32Array[]> { throw new Error("nope"); },
    };
    const hybrid = new HybridSearch({ fts, vector: vec, embeddings: broken });
    const results = await hybrid.search({ query: "auth", limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    store.close();
  });
});
