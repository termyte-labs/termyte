import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, closeDatabase } from "../src/db.js";
import { CaptureEngine } from "../src/capture/index.js";
import { createMemoryEngine } from "../src/memory/index.js";
import { computeConfidence, updateConfidenceOnSuccess, updateConfidenceOnFailure } from "../src/memory/confidence.js";
import { recordOutcome } from "../src/memory/outcome.js";
import { rankMemories } from "../src/retrieval/ranking.js";
import type { Memory, RankingWeights } from "../src/types.js";
import { SessionStore } from "../src/hook-system/session-store.js";
import { ResponseProcessor } from "../src/extraction/response-processor.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-test-"));
  dbPath = path.join(tmpDir, ".termyte", "termyte.db");
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors on Windows
  }
});

describe("Database", () => {
  it("creates database and schema", () => {
    const { db } = openDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("observations");
    expect(tableNames).toContain("pending_messages");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_feedback");
    expect(tableNames).toContain("procedures");
    closeDatabase({ db, dbPath });
  });
});

describe("SessionStore", () => {
  it("creates sessions with content and memory IDs", () => {
    const { db } = openDatabase(dbPath);
    const store = new SessionStore(db);

    const session = store.createSession({ project: "test-proj", platformSource: "termyte" });
    expect(session.contentSessionId).toBeDefined();
    expect(session.memorySessionId).toBeDefined();
    expect(session.project).toBe("test-proj");
    expect(session.platformSource).toBe("termyte");
    expect(session.status).toBe("active");
    expect(session.promptCounter).toBe(0);

    const fetched = store.getSessionByContentId(session.contentSessionId);
    expect(fetched?.id).toBe(session.id);

    closeDatabase({ db, dbPath });
  });

  it("updates session fields", () => {
    const { db } = openDatabase(dbPath);
    const store = new SessionStore(db);

    const session = store.createSession({ project: "p", platformSource: "claude-code" });
    store.updateSession(session.contentSessionId, { status: "completed", promptCounter: 5 });

    const updated = store.getSessionByContentId(session.contentSessionId);
    expect(updated?.status).toBe("completed");
    expect(updated?.promptCounter).toBe(5);

    closeDatabase({ db, dbPath });
  });
});

describe("CaptureEngine", () => {
  it("starts and ends sessions", () => {
    const { db } = openDatabase(dbPath);
    const capture = new CaptureEngine(db);

    const session = capture.startSession("test-project", "termyte");
    expect(session.contentSessionId).toBeDefined();
    expect(session.memorySessionId).toBeDefined();
    expect(session.status).toBe("active");

    capture.endSession(session.contentSessionId, "completed");
    const retrieved = capture.getSession(session.contentSessionId);
    expect(retrieved?.status).toBe("completed");

    closeDatabase({ db, dbPath });
  });
});

describe("MemoryEngine", () => {
  it("creates and retrieves memories", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);

    const memory = engine.createMemory({
      claim: "Auth tests fail when middleware config is stale",
      type: "bugfix",
      repoScope: "test-project",
      language: "typescript",
      sources: ["event-1", "event-2"],
    });

    expect(memory.id).toBeDefined();
    expect(memory.claim).toBe("Auth tests fail when middleware config is stale");
    expect(memory.type).toBe("bugfix");
    expect(memory.confidence).toBe(0.5);

    const retrieved = engine.getMemory(memory.id);
    expect(retrieved?.claim).toBe(memory.claim);

    closeDatabase({ db, dbPath });
  });

  it("updates confidence on success/failure using Bayesian formula", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);

    const memory = engine.createMemory({
      claim: "Test memory",
      type: "fact",
      repoScope: "test",
      sources: [],
    });

    // Initial: (0+1)/(0+2) = 0.5
    expect(memory.confidence).toBe(0.5);

    engine.recordSuccess(memory.id);
    const afterSuccess = engine.getMemory(memory.id);
    // After 1 success: (1+1)/(1+2) = 2/3 ≈ 0.667
    expect(afterSuccess!.confidence).toBeCloseTo(2 / 3, 5);
    expect(afterSuccess!.successCount).toBe(1);

    engine.recordFailure(memory.id);
    engine.recordFailure(memory.id);
    const afterFailures = engine.getMemory(memory.id);
    // After 1 success + 2 failures: (1+1)/(1+2+2) = 2/5 = 0.4
    expect(afterFailures!.confidence).toBeCloseTo(2 / 5, 5);
    expect(afterFailures!.successCount).toBe(1);
    expect(afterFailures!.failureCount).toBe(2);

    closeDatabase({ db, dbPath });
  });

  it("lists memories with filters", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);

    engine.createMemory({ claim: "Fact 1", type: "fact", repoScope: "proj-a", sources: [] });
    engine.createMemory({ claim: "Bugfix 1", type: "bugfix", repoScope: "proj-a", sources: [] });
    engine.createMemory({ claim: "Fact 2", type: "fact", repoScope: "proj-b", sources: [] });

    const allMemories = engine.listMemories();
    expect(allMemories).toHaveLength(3);

    const factsOnly = engine.listMemories({ type: "fact" });
    expect(factsOnly).toHaveLength(2);

    const projAOnly = engine.listMemories({ scope: "proj-a" });
    expect(projAOnly).toHaveLength(2);

    closeDatabase({ db, dbPath });
  });
});

describe("Confidence (Bayesian)", () => {
  it("starts at 0.5 with no evidence", () => {
    expect(computeConfidence(0, 0)).toBe(0.5);
  });

  it("increases with successes", () => {
    expect(computeConfidence(1, 0)).toBeCloseTo(2 / 3, 5);
    expect(computeConfidence(10, 0)).toBeCloseTo(11 / 12, 5);
  });

  it("decreases with failures", () => {
    expect(computeConfidence(0, 1)).toBeCloseTo(1 / 3, 5);
    expect(computeConfidence(0, 10)).toBeCloseTo(1 / 12, 5);
  });

  it("never reaches 0 or 1 (smoothing)", () => {
    expect(computeConfidence(1000, 0)).toBeLessThan(1);
    expect(computeConfidence(0, 1000)).toBeGreaterThan(0);
  });

  it("updateConfidenceOnSuccess increments success count", () => {
    const mem: Memory = {
      id: "1", claim: "t", type: "fact", repoScope: "r", sources: [],
      successCount: 2, failureCount: 1, confidence: 0.6,
      createdAt: "", updatedAt: "", isActive: true,
    };
    const result = updateConfidenceOnSuccess(mem);
    // (3+1)/(3+1+2) = 4/6 = 2/3
    expect(result).toBeCloseTo(2 / 3, 5);
  });

  it("updateConfidenceOnFailure increments failure count", () => {
    const mem: Memory = {
      id: "1", claim: "t", type: "fact", repoScope: "r", sources: [],
      successCount: 2, failureCount: 1, confidence: 0.6,
      createdAt: "", updatedAt: "", isActive: true,
    };
    const result = updateConfidenceOnFailure(mem);
    // (2+1)/(2+2+2) = 3/6 = 0.5
    expect(result).toBeCloseTo(0.5, 5);
  });
});

describe("Outcome Tracking", () => {
  it("records success outcome and updates confidence", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    const memory = engine.createMemory({ claim: "test", type: "fact", repoScope: "r", sources: [] });

    const updated = recordOutcome(db, {
      memoryId: memory.id,
      sessionId: "sess-1",
      outcome: "success",
      context: "Used in fixing auth bug",
    });

    expect(updated).not.toBeNull();
    expect(updated!.successCount).toBe(1);
    // (1+1)/(1+2) = 2/3
    expect(updated!.confidence).toBeCloseTo(2 / 3, 5);

    closeDatabase({ db, dbPath });
  });

  it("records failure outcome and updates confidence", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    const memory = engine.createMemory({ claim: "test", type: "fact", repoScope: "r", sources: [] });

    const updated = recordOutcome(db, {
      memoryId: memory.id,
      sessionId: "sess-2",
      outcome: "failure",
    });

    expect(updated).not.toBeNull();
    expect(updated!.failureCount).toBe(1);
    // (0+1)/(0+1+2) = 1/3
    expect(updated!.confidence).toBeCloseTo(1 / 3, 5);

    closeDatabase({ db, dbPath });
  });

  it("returns null for non-existent memory", () => {
    const { db } = openDatabase(dbPath);
    const result = recordOutcome(db, { memoryId: "nonexistent", sessionId: "s", outcome: "success" });
    expect(result).toBeNull();
    closeDatabase({ db, dbPath });
  });
});

describe("Ranking (weighted sum)", () => {
  const makeMem = (id: string, confidence: number): Memory => ({
    id, claim: `mem ${id}`, type: "fact", repoScope: "r", sources: [],
    successCount: Math.round(confidence * 10), failureCount: 0,
    confidence, createdAt: "", updatedAt: "", isActive: true,
  });

  const defaultWeights: RankingWeights = { keyword: 0.3, semantic: 0.4, confidence: 0.3 };

  it("uses weighted sum formula", () => {
    const keyword = [
      { memory: makeMem("a", 0.9), score: 1.0 },
      { memory: makeMem("b", 0.5), score: 0.5 },
    ];
    const vector: Array<{ memory: Memory; score: number }> = [];

    const results = rankMemories(keyword, vector, defaultWeights, 10);
    expect(results).toHaveLength(2);
    // a: keyword=1.0/1.0=1.0, semantic=0/0.001=0, confidence=0.9
    //    score = 0.3*1.0 + 0.4*0 + 0.3*0.9 = 0.3 + 0 + 0.27 = 0.57
    // b: keyword=0.5/1.0=0.5, semantic=0/0.001=0, confidence=0.5
    //    score = 0.3*0.5 + 0.4*0 + 0.3*0.5 = 0.15 + 0 + 0.15 = 0.30
    expect(results[0].id).toBe("a");
    expect(results[0].score).toBeCloseTo(0.57, 3);
  });

  it("respects semantic weighting as largest factor", () => {
    // a: high keyword, low semantic; b: low keyword, high semantic
    const keyword = [
      { memory: makeMem("a", 0.5), score: 0.9 },
      { memory: makeMem("b", 0.5), score: 0.3 },
    ];
    const vector = [
      { memory: makeMem("a", 0.5), score: 0.2 },
      { memory: makeMem("b", 0.5), score: 0.9 },
    ];

    const results = rankMemories(keyword, vector, defaultWeights, 10);
    // semantic weight (0.4) > keyword weight (0.3), so b should rank higher
    expect(results[0].id).toBe("b");
  });

  it("limits results", () => {
    const keyword = [
      { memory: makeMem("a", 0.5), score: 1.0 },
      { memory: makeMem("b", 0.5), score: 0.8 },
    ];
    const results = rankMemories(keyword, [], defaultWeights, 1);
    expect(results).toHaveLength(1);
  });
});

describe("Decay", () => {
  it("computes decay scores", async () => {
    const { computeDecayScore } = await import("../src/memory/decay.js");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const freshMemory = {
      id: "1", claim: "test", type: "fact" as const, repoScope: "test",
      sources: [], successCount: 5, failureCount: 0, confidence: 0.9,
      lastOutcomeAt: now, createdAt: now, updatedAt: now, isActive: true,
    };

    const staleMemory = {
      ...freshMemory, id: "2", lastOutcomeAt: old, updatedAt: old,
    };

    const freshScore = computeDecayScore(freshMemory);
    const staleScore = computeDecayScore(staleMemory);

    expect(freshScore).toBeGreaterThan(staleScore);
  });
});
