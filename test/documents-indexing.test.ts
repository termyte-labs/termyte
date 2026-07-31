import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { DocumentStore } from "../src/storage/documents.js";
import { SqliteVecIndex } from "../src/context/retrieval/indexing/sqlite-vec-index.js";
import { reciprocalRankFusion, rrf } from "../src/context/retrieval/rrf.js";

let ctx: DatabaseContext;
let store: Store;
let documents: DocumentStore;

beforeEach(() => {
  ctx = openDatabase(":memory:");
  store = new Store(ctx);
  documents = new DocumentStore(store.getDB());
});

afterEach(() => {
  store.close();
});

describe("DocumentStore FTS indexing", () => {
  it("indexes inserted documents for sparse search", () => {
    documents.upsertDocument({
      id: "memory:auth",
      doc_type: "memory",
      source_id: "auth",
      session_id: "s1",
      content: "Auth tokens must be trimmed before validation.",
      files: ["src/auth/token.ts"],
      tags: ["bugfix"],
      importance: 0.8,
      confidence: 0.9,
      recency_ts: 10,
      created_at: 10,
      updated_at: 10,
    });

    const results = documents.searchSparse({ query: "auth token", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]!.document.id).toBe("memory:auth");
    expect(results[0]!.score).toBeGreaterThan(0);
  });

  it("updates FTS rows when document content changes", () => {
    documents.upsertDocument({
      id: "memory:search",
      doc_type: "memory",
      source_id: "search",
      content: "Use blob scanning for vector search.",
      tags: ["decision"],
    });

    expect(documents.searchSparse({ query: "blob scanning" })).toHaveLength(1);

    documents.upsertDocument({
      id: "memory:search",
      doc_type: "memory",
      source_id: "search",
      content: "Use sqlite vec for native vector search.",
      tags: ["decision"],
    });

    expect(documents.searchSparse({ query: "blob scanning" })).toHaveLength(0);
    expect(documents.searchSparse({ query: "sqlite vec" })[0]!.document.id).toBe("memory:search");
  });

  it("removes hard-deleted documents from sparse search", () => {
    documents.upsertDocument({
      id: "observation:dead",
      doc_type: "observation",
      source_id: "dead",
      content: "Temporary observation about dead letter jobs.",
    });

    expect(documents.searchSparse({ query: "dead letter" })).toHaveLength(1);

    documents.hardDeleteDocument("observation:dead");

    expect(documents.searchSparse({ query: "dead letter" })).toHaveLength(0);
  });

  it("excludes soft-deleted documents from sparse search", () => {
    documents.upsertDocument({
      id: "memory:superseded",
      doc_type: "memory",
      source_id: "superseded",
      content: "This superseded memory should not appear in retrieval.",
    });

    documents.softDeleteDocument("memory:superseded", 123);

    expect(documents.searchSparse({ query: "superseded memory" })).toHaveLength(0);
  });

  it("filters sparse search by document type and session", () => {
    documents.upsertDocument({
      id: "memory:one",
      doc_type: "memory",
      source_id: "one",
      session_id: "s1",
      content: "SQLite migrations require explicit triggers.",
    });
    documents.upsertDocument({
      id: "observation:one",
      doc_type: "observation",
      source_id: "one",
      session_id: "s1",
      content: "SQLite migrations require explicit triggers.",
    });
    documents.upsertDocument({
      id: "memory:two",
      doc_type: "memory",
      source_id: "two",
      session_id: "s2",
      content: "SQLite migrations require explicit triggers.",
    });

    const memoryResults = documents.searchSparse({
      query: "sqlite migrations",
      types: ["memory"],
      sessionId: "s1",
      limit: 10,
    });

    expect(memoryResults.map((r) => r.document.id)).toEqual(["memory:one"]);
  });
});

describe("SqliteVecIndex fallback", () => {
  it("reports unavailable and preserves FTS-only sparse retrieval when forced unavailable", () => {
    const index = new SqliteVecIndex(store.getDB(), {
      dimensions: 4,
      model: "fixed-test",
      forceUnavailable: true,
    });

    expect(index.ensureSchema()).toBe(false);
    expect(index.isAvailable()).toBe(false);

    documents.upsertDocument({
      id: "memory:fts-only",
      doc_type: "memory",
      source_id: "fts-only",
      content: "FTS fallback still retrieves documents without sqlite vec.",
    });

    expect(documents.searchSparse({ query: "fts fallback" })[0]!.document.id).toBe("memory:fts-only");
    expect(index.search(new Float32Array([1, 0, 0, 0]), 5)).toEqual([]);
  });

  it("throws a clear write error when sqlite-vec is unavailable", () => {
    const index = new SqliteVecIndex(store.getDB(), {
      dimensions: 4,
      model: "fixed-test",
      forceUnavailable: true,
    });

    index.ensureSchema();

    expect(() => index.upsert("memory:x", new Float32Array([1, 0, 0, 0])))
      .toThrow(/sqlite-vec is unavailable/);
  });
});

describe("Reciprocal Rank Fusion", () => {
  it("scores lower ranks below higher ranks", () => {
    expect(rrf(1)).toBeGreaterThan(rrf(2));
  });

  it("ranks documents found by multiple sources above single-source hits", () => {
    const fused = reciprocalRankFusion([
      {
        source: "sparse",
        weight: 0.9,
        items: [
          { docId: "memory:shared" },
          { docId: "memory:sparse-only" },
        ],
      },
      {
        source: "dense",
        weight: 1.0,
        items: [
          { docId: "memory:dense-only" },
          { docId: "memory:shared" },
        ],
      },
    ]);

    expect(fused[0]!.docId).toBe("memory:shared");
    expect(fused[0]!.sources.map((source) => source.source).sort()).toEqual(["dense", "sparse"]);
  });
});