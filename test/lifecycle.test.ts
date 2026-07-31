import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import {
  memoryDecayScore,
  nextMemoryStateAfterDecay,
  type MemoryLifecycleRow,
} from "../src/context/lifecycle/decay.js";
import {
  applyFeedback,
  defaultFeedbackWeight,
  feedbackDelta,
  type FeedbackState,
} from "../src/context/lifecycle/feedback.js";
import {
  canonicalMemoryKey,
  cosineSimilarity,
  fileOverlapScore,
  shouldDeduplicate,
} from "../src/context/lifecycle/dedupe.js";

const dayMs = 86_400_000;

function memory(overrides: Partial<MemoryLifecycleRow> = {}): MemoryLifecycleRow {
  return {
    id: 1,
    type: "fact",
    state: "active",
    importance: 0.5,
    confidence: 0.5,
    usage_count: 0,
    created_at: 1_000_000,
    ...overrides,
  };
}

function feedbackState(overrides: Partial<FeedbackState> = {}): FeedbackState {
  return {
    state: "active",
    importance: 0.5,
    confidence: 0.5,
    usage_count: 0,
    last_accessed_at: null,
    last_reinforced_at: null,
    ...overrides,
  };
}

describe("memory lifecycle migrations", () => {
  it("creates lifecycle columns and tables idempotently", () => {
    const ctx = openDatabase(":memory:");
    const store = new Store(ctx);
    new Store(ctx);

    const columns = ctx.db.prepare(`PRAGMA table_info(memories)`).all() as Array<{ name: string }>;
    const columnNames = new Set(columns.map((column) => column.name));

    expect(columnNames.has("state")).toBe(true);
    expect(columnNames.has("importance")).toBe(true);
    expect(columnNames.has("confidence")).toBe(true);
    expect(columnNames.has("usage_count")).toBe(true);
    expect(columnNames.has("last_accessed_at")).toBe(true);
    expect(columnNames.has("last_reinforced_at")).toBe(true);
    expect(columnNames.has("decayed_score")).toBe(true);
    expect(columnNames.has("content_hash")).toBe(true);
    expect(columnNames.has("canonical_key")).toBe(true);
    expect(columnNames.has("superseded_by")).toBe(true);

    const tables = ctx.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('memory_edges', 'memory_feedback')
    `).all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name).sort()).toEqual([
      "memory_edges",
      "memory_feedback",
    ]);

    store.close();
  });
});

describe("memoryDecayScore", () => {
  it("decreases as memory age increases", () => {
    const now = 100 * dayMs;
    const fresh = memory({ created_at: now - dayMs });
    const old = memory({ created_at: now - 120 * dayMs });

    expect(memoryDecayScore(fresh, now)).toBeGreaterThan(memoryDecayScore(old, now));
  });

  it("increases with access frequency and recent access", () => {
    const now = 100 * dayMs;
    const unused = memory({ created_at: now - 90 * dayMs, usage_count: 0 });
    const used = memory({
      created_at: now - 90 * dayMs,
      usage_count: 12,
      last_accessed_at: now - dayMs,
    });

    expect(memoryDecayScore(used, now)).toBeGreaterThan(memoryDecayScore(unused, now));
  });

  it("keeps deleted and superseded states terminal during decay", () => {
    expect(nextMemoryStateAfterDecay(memory({ state: "deleted" }), 0.99)).toBe("deleted");
    expect(nextMemoryStateAfterDecay(memory({ state: "superseded" }), 0.99)).toBe("superseded");
  });

  it("marks low scoring active memories stale", () => {
    expect(nextMemoryStateAfterDecay(memory({ state: "active" }), 0.21)).toBe("stale");
    expect(nextMemoryStateAfterDecay(memory({ state: "active" }), 0.22)).toBe("active");
  });
});

describe("feedback lifecycle math", () => {
  it("returns deterministic deltas and default weights", () => {
    expect(feedbackDelta("shown")).toEqual({
      importanceDelta: 0,
      confidenceDelta: 0,
      usageDelta: 0,
    });
    expect(defaultFeedbackWeight("used")).toBe(0);
    expect(defaultFeedbackWeight("helpful")).toBe(0.25);
    expect(defaultFeedbackWeight("harmful")).toBe(-1);
  });

  it("records stale memory use without treating it as reinforcement", () => {
    const now = 1234;
    const next = applyFeedback(feedbackState({ state: "stale" }), "used", now);

    expect(next.state).toBe("stale");
    expect(next.usage_count).toBe(1);
    expect(next.importance).toBeCloseTo(0.5);
    expect(next.confidence).toBeCloseTo(0.5);
    expect(next.last_accessed_at).toBe(now);
    expect(next.last_reinforced_at).toBeNull();
  });

  it("clamps importance and confidence", () => {
    const high = applyFeedback(
      feedbackState({ importance: 0.99, confidence: 0.99 }),
      "helpful",
      1,
    );
    expect(high.importance).toBe(1);
    expect(high.confidence).toBe(1);

    const low = applyFeedback(
      feedbackState({ importance: 0.01, confidence: 0.01 }),
      "corrected",
      1,
    );
    expect(low.confidence).toBe(0);
    expect(low.state).toBe("conflicted");
  });

  it("applies ignored and downranked importance penalties", () => {
    expect(applyFeedback(feedbackState(), "ignored", 1).importance).toBeCloseTo(0.48);
    expect(applyFeedback(feedbackState(), "downranked", 1).importance).toBeCloseTo(0.45);
  });
});

describe("persisted memory feedback", () => {
  it("records feedback and updates memory lifecycle scores atomically", () => {
    const store = new Store(openDatabase(":memory:"));
    try {
      store.upsertSession("feedback-session", "test", "repo", "/repo");
      const memory = store.insertMemory({
        session_id: "feedback-session",
        repo_id: "repo",
        workspace_root: "/repo",
        type: "fact",
        title: "Persist feedback",
        description: "Feedback should update memory scores.",
        files_read: [],
        files_modified: [],
        source_observation_ids: [],
        source_trace_ids: [],
        created_at: 100,
        embedding: null,
      });

      const result = store.recordMemoryFeedback({
        id: `memory:${memory.id}`,
        event: "used",
        contextInjectionId: "ctx-1",
        nowMs: 200,
      });

      expect(result).toEqual({ recorded: true, memoryId: memory.id });
      const updated = store.getMemory(memory.id)!;
      expect(updated.usage_count).toBe(1);
      expect(updated.importance).toBeCloseTo(0.5);
      expect(updated.confidence).toBeCloseTo(0.5);
      expect(updated.last_accessed_at).toBe(200);

      const feedback = store.getDB().prepare(`
        SELECT event_type, context_injection_id
        FROM memory_feedback
        WHERE memory_id = ?
      `).get(memory.id) as any;
      expect(feedback).toEqual({
        event_type: "used",
        context_injection_id: "ctx-1",
      });
    } finally {
      store.close();
    }
  });

  it("reinforces only explicit helpful feedback and suppresses harmful memory immediately", () => {
    const store = new Store(openDatabase(":memory:"));
    try {
      store.upsertSession("feedback-session", "test", "repo", "/repo");
      const memory = store.insertMemory({
        session_id: "feedback-session", repo_id: "repo", workspace_root: "/repo", type: "fact",
        title: "Explicit utility", description: null, files_read: [], files_modified: [],
        source_observation_ids: [], source_trace_ids: [], created_at: 100, embedding: null,
      });
      store.recordMemoryFeedback({ id: `memory:${memory.id}`, event: "helpful", nowMs: 200 });
      expect(store.getMemory(memory.id)).toMatchObject({ importance: 0.56, confidence: 0.54, lifecycle_state: "active" });
      store.recordMemoryFeedback({ id: `memory:${memory.id}`, event: "harmful", nowMs: 201 });
      expect(store.getMemory(memory.id)).toMatchObject({ lifecycle_state: "conflicted", state: "conflicted" });
      expect(store.getMemoryFeedbackScores([memory.id]).get(memory.id)).toBe(-0.75);
    } finally {
      store.close();
    }
  });
});

describe("dedupe helpers", () => {
  it("normalizes canonical keys across dates, hashes, whitespace, case, and file order", () => {
    const a = canonicalMemoryKey({
      type: "fact",
      content: "Use sqlite-vec on 2026-07-01 after commit abcdef1234567890",
      files: ["SRC\\Retrieval\\Hybrid.ts", "src/storage/store.ts"],
    });
    const b = canonicalMemoryKey({
      type: "fact",
      content: " use   SQLITE-VEC on 2025-01-30 after commit ffffff1234567890 ",
      files: ["src/storage/store.ts", "src/retrieval/hybrid.ts"],
    });

    expect(a).toBe(b);
  });

  it("scores file overlap and cosine similarity deterministically", () => {
    expect(fileOverlapScore(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toBe(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([1, 0]))).toBe(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBe(0);
  });

  it("detects duplicates by canonical key or scoped vector similarity", () => {
    const key = canonicalMemoryKey({ type: "fact", content: "same", files: ["src/a.ts"] });
    expect(
      shouldDeduplicate(
        {
          id: 1,
          type: "fact",
          canonical_key: key,
          files_read: [],
          files_modified: [],
          embedding: null,
        },
        {
          id: 2,
          type: "fact",
          canonical_key: key,
          files_read: [],
          files_modified: [],
          embedding: null,
        },
      ),
    ).toBe(true);

    expect(
      shouldDeduplicate(
        {
          id: 1,
          type: "fact",
          canonical_key: null,
          files_read: ["src/a.ts"],
          files_modified: [],
          embedding: new Float32Array([1, 0]),
        },
        {
          id: 2,
          type: "fact",
          canonical_key: null,
          files_read: ["src/a.ts"],
          files_modified: [],
          embedding: new Float32Array([0.99, 0.01]),
        },
      ),
    ).toBe(true);
  });
});
