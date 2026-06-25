import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { FTSSearch } from "../src/retrieval/fts.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("Store", () => {
  it("round-trips a session", () => {
    const store = new Store(ctx);
    const session = store.upsertSession("sess-1", "demo");
    expect(session.session_id).toBe("sess-1");
    expect(session.project).toBe("demo");
    expect(session.started_at).toBeGreaterThan(0);
    const fetched = store.getSession("sess-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.project).toBe("demo");
    store.close();
  });

  it("upserts a session idempotently (updates project)", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    store.upsertSession("sess-1", "renamed");
    const fetched = store.getSession("sess-1");
    expect(fetched!.project).toBe("renamed");
    store.close();
  });

  it("round-trips a trace with JSON fields", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    const trace = store.insertTrace({
      session_id: "sess-1",
      timestamp: 1000,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_output: "content",
      files_read: ["src/a.ts"],
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });
    expect(trace.id).toBeGreaterThan(0);
    expect(trace.tool_input).toEqual({ file_path: "src/a.ts" });
    expect(trace.tool_output).toBe("content");
    expect(trace.files_read).toEqual(["src/a.ts"]);
    store.close();
  });

  it("stores a memory and FTS-queries it back", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    const id = store.insertMemory({
      session_id: "sess-1",
      type: "bugfix",
      title: "Auth token whitespace",
      subtitle: "tokens have leading spaces",
      facts: ["Repro: token with space", "Fix: trim"],
      narrative: "We now trim tokens before validating.",
      concepts: ["problem-solution", "gotcha"],
      files_read: ["src/auth/token.ts"],
      files_modified: ["src/auth/token.ts"],
      created_at: Date.now(),
      embedding: null,
    }).id;
    expect(id).toBeGreaterThan(0);

    const fts = new FTSSearch(store);
    const results = fts.search({ query: "auth token whitespace" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toContain("Auth");
    expect(results[0]!.narrative).toContain("trim");
    store.close();
  });

  it("upserts a summary idempotently by session_id", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    const s1 = store.upsertSummary({
      session_id: "sess-1",
      request: "r",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      notes: null,
      created_at: 1,
    });
    const s2 = store.upsertSummary({
      session_id: "sess-1",
      request: "r2",
      investigated: null,
      learned: null,
      completed: null,
      next_steps: null,
      notes: null,
      created_at: 2,
    });
    expect(s1.id).toBe(s2.id);
    const fetched = store.getSummary("sess-1");
    expect(fetched!.request).toBe("r2");
    store.close();
  });

  it("marks traces as processed and excludes them from getUnprocessedTraces", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    const t1 = store.insertTrace({
      session_id: "sess-1",
      timestamp: 1,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });
    const t2 = store.insertTrace({
      session_id: "sess-1",
      timestamp: 2,
      event_type: "tool_use",
      tool_name: "Read",
      tool_input: null,
      tool_output: null,
      files_read: null,
      files_modified: null,
      user_prompt: null,
      final_response: null,
    });
    expect(store.getUnprocessedTraces().length).toBe(2);
    store.markTraceProcessed(t1.id);
    const remaining = store.getUnprocessedTraces();
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.id).toBe(t2.id);
    store.close();
  });

  it("stores and reads back an embedding as Float32Array", () => {
    const store = new Store(ctx);
    store.upsertSession("sess-1", "demo");
    const vec = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const m = store.insertMemory({
      session_id: "sess-1",
      type: "discovery",
      title: "t",
      subtitle: null,
      facts: [],
      narrative: null,
      concepts: [],
      files_read: [],
      files_modified: [],
      created_at: Date.now(),
      embedding: null,
    });
    store.updateMemoryEmbedding(m.id, vec);
    const got = store.getMemory(m.id);
    expect(got).not.toBeNull();
    expect(got!.embedding).not.toBeNull();
    const arr = Array.from(got!.embedding!);
    expect(arr).toHaveLength(4);
    expect(arr[0]).toBeCloseTo(0.1, 5);
    expect(arr[1]).toBeCloseTo(0.2, 5);
    expect(arr[2]).toBeCloseTo(0.3, 5);
    expect(arr[3]).toBeCloseTo(0.4, 5);
    store.close();
  });

  it("filters getRecentMemories by project", () => {
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
      created_at: 2,
      embedding: null,
    });
    const alpha = store.getRecentMemories(10, "alpha");
    expect(alpha.length).toBe(1);
    expect(alpha[0]!.title).toBe("alpha memory");
    const beta = store.getRecentMemories(10, "beta");
    expect(beta.length).toBe(1);
    expect(beta[0]!.title).toBe("beta memory");
    const all = store.getRecentMemories(10);
    expect(all.length).toBe(2);
    store.close();
  });
});
