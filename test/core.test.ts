import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, closeDatabase } from "../src/db.js";
import { CaptureEngine } from "../src/capture/index.js";
import { createMemoryEngine } from "../src/memory/index.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-test-"));
  dbPath = path.join(tmpDir, ".termyte", "termyte.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Database", () => {
  it("creates database and schema", () => {
    const { db } = openDatabase(dbPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("sessions");
    expect(tableNames).toContain("events");
    expect(tableNames).toContain("memories");
    expect(tableNames).toContain("memory_feedback");
    expect(tableNames).toContain("procedures");
    closeDatabase({ db, dbPath });
  });
});

describe("CaptureEngine", () => {
  it("starts and ends sessions", () => {
    const { db } = openDatabase(dbPath);
    const capture = new CaptureEngine(db);

    const session = capture.startSession("claude", tmpDir, "main");
    expect(session.id).toBeDefined();
    expect(session.agent).toBe("claude");
    expect(session.status).toBe("running");

    capture.endSession(session.id, "completed", "Test session");
    const retrieved = capture.getSession(session.id);
    expect(retrieved?.status).toBe("completed");
    expect(retrieved?.summary).toBe("Test session");

    closeDatabase({ db, dbPath });
  });

  it("records events", () => {
    const { db } = openDatabase(dbPath);
    const capture = new CaptureEngine(db);

    const session = capture.startSession("claude", tmpDir);
    const event = capture.recordEvent({
      sessionId: session.id,
      source: "cli",
      actorType: "agent",
      eventType: "command",
      summary: "npm test",
    });

    expect(event.id).toBeDefined();
    expect(event.summary).toBe("npm test");

    const events = capture.getEvents(session.id);
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("npm test");

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

  it("updates confidence on success/failure", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);

    const memory = engine.createMemory({
      claim: "Test memory",
      type: "fact",
      repoScope: "test",
      sources: [],
    });

    const initialConfidence = memory.confidence;
    engine.recordSuccess(memory.id);
    const afterSuccess = engine.getMemory(memory.id);
    expect(afterSuccess!.confidence).toBeGreaterThan(initialConfidence);

    engine.recordFailure(memory.id);
    engine.recordFailure(memory.id);
    const afterFailures = engine.getMemory(memory.id);
    expect(afterFailures!.confidence).toBeLessThan(afterSuccess!.confidence);

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

describe("Decay", () => {
  it("computes decay scores", async () => {
    const { computeDecayScore } = await import("../src/memory/decay.js");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();

    const freshMemory = {
      id: "1",
      claim: "test",
      type: "fact" as const,
      repoScope: "test",
      sources: [],
      successCount: 5,
      failureCount: 0,
      confidence: 0.9,
      lastVerified: now,
      createdAt: now,
      updatedAt: now,
      isActive: true,
    };

    const staleMemory = {
      ...freshMemory,
      id: "2",
      lastVerified: old,
      updatedAt: old,
    };

    const freshScore = computeDecayScore(freshMemory);
    const staleScore = computeDecayScore(staleMemory);

    expect(freshScore).toBeGreaterThan(staleScore);
  });
});
