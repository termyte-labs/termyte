import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { FTSSearch } from "../src/context/retrieval/fts.js";
import { VectorSearch } from "../src/context/retrieval/vector.js";
import { HybridSearch, type HybridSearchResult } from "../src/context/retrieval/hybrid.js";
import { NoOpEmbeddingsProvider, type EmbeddingsProvider } from "../src/context/retrieval/embeddings.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

class FixedEmbeddings implements EmbeddingsProvider {
  readonly dimensions: number;
  private table: Map<string, Float32Array>;

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
  store.upsertSession("s1", "demo", "repo-1", "/workspace");
  store.insertMemory({
    session_id: "s1", repo_id: "repo-1", workspace_root: "/workspace",
    type: "bugfix",
    title: "Auth token whitespace",
    description: "Tokens had trailing spaces. The auth path now trims tokens before validation.",
    files_read: ["src/auth/token.ts"],
    files_modified: ["src/auth/token.ts"],
    source_observation_ids: [1],
    source_trace_ids: [10],
    created_at: Date.now(),
    embedding: null,
  });
  store.insertMemory({
    session_id: "s1", repo_id: "repo-1", workspace_root: "/workspace",
    type: "convention",
    title: "Added login rate limiting",
    description: "A new rate limiter sits in front of the auth handler. 5 attempts per minute per IP.",
    files_read: [],
    files_modified: ["src/auth/middleware.ts", "src/auth/rate-limit.ts"],
    source_observation_ids: [2],
    source_trace_ids: [11],
    created_at: Date.now() - 1000,
    embedding: null,
  });
  store.insertMemory({
    session_id: "s1", repo_id: "repo-1", workspace_root: "/workspace",
    type: "fact",
    title: "Database indexes need rebalancing",
    description: "After 6 months of growth the email index bloats query plans. The users.email index is 4x larger than expected.",
    files_read: [],
    files_modified: [],
    source_observation_ids: [3],
    source_trace_ids: [12],
    created_at: Date.now() - 2000,
    embedding: null,
  });
}

function seedApplicabilityMemories(store: Store): void {
  store.upsertSession("s2", "demo", "repo-1", "/workspace");
  store.insertMemory({
    session_id: "s2", repo_id: "repo-1", workspace_root: "/workspace",
    type: "procedure",
    title: "Run tests",
    description: "Use npm test for the auth subsystem.",
    files_read: ["src/auth/token.ts"],
    files_modified: ["src/auth/token.ts"],
    source_observation_ids: [4],
    source_trace_ids: [13],
    created_at: Date.now(),
    embedding: null,
    applicability_evidence: {
      files: ["src/auth/token.ts"],
      commands: ["npm test"],
      trace_ids: [13],
      observation_ids: [4],
    },
  });
  store.insertMemory({
    session_id: "s2", repo_id: "repo-1", workspace_root: "/workspace",
    type: "procedure",
    title: "Run tests",
    description: "Use npm test for the database subsystem.",
    files_read: ["src/db/query.ts"],
    files_modified: ["src/db/query.ts"],
    source_observation_ids: [5],
    source_trace_ids: [14],
    created_at: Date.now(),
    embedding: null,
    applicability_evidence: {
      files: ["src/db/query.ts"],
      commands: ["pnpm lint"],
      trace_ids: [14],
      observation_ids: [5],
    },
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

  it("retrieves candidates when natural-language framing words are absent", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const results = new FTSSearch(store).search({ query: "Which token behavior should the user remember?" });
    expect(results.some((memory) => memory.title === "Auth token whitespace")).toBe(true);
    store.close();
  });

  it("returns no results for nonsense queries", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const fts = new FTSSearch(store);
    const results = fts.search({ query: "qwertyuiop zzzz" });
    expect(results.length).toBe(0);
    store.close();
  });

  it("filters by repo_id", () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "alpha", "repo-a", "/wa");
    store.upsertSession("s2", "beta", "repo-b", "/wb");
    store.insertMemory({
      session_id: "s1", repo_id: "repo-a", workspace_root: "/wa",
      type: "fact", title: "alpha memory", description: "something memorable from alpha",
      files_read: [], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: 1, embedding: null,
    });
    store.insertMemory({
      session_id: "s2", repo_id: "repo-b", workspace_root: "/wb",
      type: "fact", title: "beta memory", description: "something memorable from beta",
      files_read: [], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: 1, embedding: null,
    });
    const fts = new FTSSearch(store);
    expect(fts.search({ query: "memory", repo_id: "repo-a" })[0]!.title).toBe("alpha memory");
    expect(fts.search({ query: "memory", repo_id: "repo-b" })[0]!.title).toBe("beta memory");
    store.close();
  });
});

describe("VectorSearch", () => {
  it("returns memories with cosine similarity scores", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
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
    expect(results[0]!.memory.title).toBe("Auth token whitespace");
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
    store.close();
  });

  it("ranks more similar documents above less similar ones", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
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
    const top = results[0]!;
    const rest = results.slice(1);
    expect(rest.every((r) => r.score <= top.score)).toBe(true);
    store.close();
  });

  it("filters out memories without embeddings", () => {
    const store = new Store(ctx);
    seedMemories(store);
    const v = new VectorSearch(store);
    const results = v.search({ query: new Float32Array([0, 0, 0, 0]), limit: 10 });
    expect(results.length).toBe(0);
    store.close();
  });

  it("boosts memories with file overlap", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo-1", "/w");
    store.insertMemory({
      session_id: "s1", repo_id: "repo-1", workspace_root: "/w",
      type: "bugfix", title: "Fixed auth", description: "auth fix",
      files_read: [], files_modified: ["src/auth/token.ts"],
      source_observation_ids: [], source_trace_ids: [],
      created_at: Date.now(), embedding: new Float32Array([0, 1, 0, 0]),
    });
    store.insertMemory({
      session_id: "s1", repo_id: "repo-1", workspace_root: "/w",
      type: "bugfix", title: "Fixed DB", description: "db fix",
      files_read: [], files_modified: ["src/db/query.ts"],
      source_observation_ids: [], source_trace_ids: [],
      created_at: Date.now(), embedding: new Float32Array([0, 1, 0, 0]),
    });
    const v = new VectorSearch(store);
    const query = new Float32Array([0, 1, 0, 0]);
    // Without file boost, both score identically.
    const noBoost = v.search({ query, limit: 2 });
    expect(noBoost[0]!.score).toBeCloseTo(noBoost[1]!.score, 5);

    // With file boost, the auth memory should rank higher.
    const boosted = v.search({ query, limit: 2, currentFiles: ["src/auth/token.ts"] });
    expect(boosted[0]!.memory.title).toBe("Fixed auth");
    expect(boosted[0]!.score).toBeGreaterThan(boosted[1]!.score);
    store.close();
  });

});

describe("HybridSearch", () => {
  it("combines FTS and vector results with RRF", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const embeddings = new FixedEmbeddings();
    const q = await embeddings.embed("auth token");
    for (const m of store.getRecentMemories(100)) {
      if (m.title === "Auth token whitespace") store.updateMemoryEmbedding(m.id, q);
    }
    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const search = new HybridSearch({ fts, vector, embeddings });
    const results = await search.search({ query: "auth token" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.memory.title).toContain("Auth");
    store.close();
  });

  it("degrades to FTS-only when embeddings throw", async () => {
    const store = new Store(ctx);
    seedMemories(store);
    const badEmbed: EmbeddingsProvider = {
      dimensions: 4,
      async embed(): Promise<Float32Array> { throw new Error("down"); },
      async embedBatch(): Promise<Float32Array[]> { throw new Error("down"); },
    };
    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const search = new HybridSearch({ fts, vector, embeddings: badEmbed });
    const results = await search.search({ query: "auth token" });
    expect(results.length).toBeGreaterThan(0);
    store.close();
  });

  it("reranks equally relevant candidates using explicit feedback with a score breakdown", async () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo-1", "/workspace");
    const ids = ["older", "reinforced"].map((title) => store.insertMemory({
      session_id: "s1", repo_id: "repo-1", workspace_root: "/workspace", type: "fact",
      title: `shared retrieval ${title}`, description: "shared retrieval evidence",
      files_read: [], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: Date.now(), embedding: null,
    }).id);
    store.recordMemoryFeedback({ id: `memory:${ids[1]}`, event: "helpful", source: "test" });
    const unavailable: EmbeddingsProvider = {
      dimensions: 4,
      async embed(): Promise<Float32Array> { throw new Error("offline"); },
      async embedBatch(): Promise<Float32Array[]> { throw new Error("offline"); },
    };
    const search = new HybridSearch({
      fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings: unavailable, feedbackStore: store,
    });
    const results = await search.search({ query: "shared retrieval", repo_id: "repo-1" });
    expect(results[0]!.memory.id).toBe(ids[1]);
    expect(results[0]!.score_breakdown.feedback_adjustment).toBeGreaterThan(0);
    expect(results[0]!.combined_score).toBe(results[0]!.score_breakdown.final_score);
    store.close();
  });

  it("prefers the memory whose applicability evidence matches the current task over same-text stale context", async () => {
    const store = new Store(ctx);
    store.upsertSession("s2", "demo", "repo-1", "/workspace");
    const sharedVector = new Float32Array([1, 0, 0, 0]);
    const applicable = store.insertMemory({
      session_id: "s2", repo_id: "repo-1", workspace_root: "/workspace", type: "procedure",
      title: "Use npm test", description: "Run the test suite before shipping.",
      files_read: ["src/auth/token.ts"], files_modified: ["src/auth/token.ts"],
      source_observation_ids: [10], source_trace_ids: [20],
      created_at: Date.now(), embedding: sharedVector,
      applicability_evidence: {
        files: ["src/auth/token.ts"],
        commands: ["npm test"],
        trace_ids: [20],
        observation_ids: [10],
      },
    }).id;
    const stale = store.insertMemory({
      session_id: "s2", repo_id: "repo-1", workspace_root: "/workspace", type: "procedure",
      title: "Use npm test", description: "Run the test suite before shipping.",
      files_read: ["src/db/query.ts"], files_modified: ["src/db/query.ts"],
      source_observation_ids: [11], source_trace_ids: [21],
      created_at: Date.now(), embedding: sharedVector,
      applicability_evidence: {
        files: ["src/db/query.ts"],
        commands: ["pnpm lint"],
        trace_ids: [21],
        observation_ids: [11],
      },
    }).id;
    const embeddings = new FixedEmbeddings();
    embeddings.set("npm test", sharedVector);
    const search = new HybridSearch({
      fts: new FTSSearch(store),
      vector: new VectorSearch(store),
      embeddings,
      feedbackStore: store,
    });

    const results = await search.search({
      query: "npm test",
      repo_id: "repo-1",
      currentFiles: ["src/auth/token.ts"],
      limit: 2,
    });

    expect(results[0]!.memory.id).toBe(applicable);
    expect(results[0]!.score_breakdown.applicability_adjustment).toBeGreaterThan(0);
    expect(results.some((result) => result.memory.id === stale)).toBe(true);
    expect(results.find((result) => result.memory.id === stale)!.combined_score).toBeLessThan(results[0]!.combined_score);
    store.close();
  });
});
