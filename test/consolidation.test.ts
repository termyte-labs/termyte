import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { openDatabase, closeDatabase } from "../src/db.js";
import { createMemoryEngine } from "../src/memory/index.js";
import { listActiveScopes, listActiveMemoriesForScope, normalizePlan, type ConsolidationAction } from "../src/consolidation/agent.js";
import { buildConsolidationPrompt } from "../src/consolidation/prompts.js";
import { createFakeGemini, type FakeGemini } from "./fake-gemini.js";
import type { Memory } from "../src/types.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-consolidate-"));
  dbPath = path.join(tmpDir, ".termyte", "termyte.db");
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("Consolidation: listActiveScopes + listActiveMemoriesForScope", () => {
  it("lists scopes and their memories", () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "a", type: "fact", repoScope: "proj-a", sources: [] });
    engine.createMemory({ claim: "b", type: "fact", repoScope: "proj-a", sources: [] });
    engine.createMemory({ claim: "c", type: "bugfix", repoScope: "proj-b", sources: [] });

    expect(listActiveScopes(db)).toEqual(["proj-a", "proj-b"]);
    expect(listActiveMemoriesForScope(db, "proj-a", 50)).toHaveLength(2);
    expect(listActiveMemoriesForScope(db, "proj-b", 50)).toHaveLength(1);

    closeDatabase({ db, dbPath });
  });
});

describe("Consolidation: normalizePlan", () => {
  it("accepts a well-formed plan", () => {
    const raw = {
      actions: [
        { kind: "merge", sourceIndices: [0, 1], claim: "merged", type: "warning", language: "ts", rationale: "same" },
      ],
    };
    const plan = normalizePlan(raw);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].kind).toBe("merge");
    expect(plan.actions[0].language).toBe("ts");
  });

  it("rejects invalid kinds and types", () => {
    const raw = {
      actions: [
        { kind: "invalid", sourceIndices: [0], claim: "x", type: "fact", rationale: "" },
        { kind: "merge", sourceIndices: [0], claim: "x", type: "BOGUS", rationale: "" },
        { kind: "merge", sourceIndices: [], claim: "x", type: "fact", rationale: "" },
        { kind: "merge", sourceIndices: [0], claim: "", type: "fact", rationale: "" },
      ],
    };
    const plan = normalizePlan(raw);
    expect(plan.actions).toHaveLength(0);
  });

  it("returns empty plan for null / non-object / missing actions", () => {
    expect(normalizePlan(null).actions).toEqual([]);
    expect(normalizePlan({}).actions).toEqual([]);
    expect(normalizePlan({ actions: "not-an-array" }).actions).toEqual([]);
  });

  it("treats empty actions as 'no consolidation needed'", () => {
    expect(normalizePlan({ actions: [] }).actions).toEqual([]);
  });
});

describe("Consolidation: buildConsolidationPrompt", () => {
  it("lists claims with indices and metadata", () => {
    const prompt = buildConsolidationPrompt([
      { claim: "first", type: "fact", repoScope: "p", language: "ts" },
      { claim: "second", type: "warning", repoScope: "p" },
    ]);
    expect(prompt).toContain("Project: p");
    expect(prompt).toContain("[0] (fact) [ts] first");
    expect(prompt).toContain("[1] (warning) second");
  });
});

describe("Consolidation: end-to-end merge", () => {
  it("merges two duplicates into one new memory, deactivates sources", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    const a = engine.createMemory({ claim: "Auth uses a hardcoded token check", type: "warning", repoScope: "p", sources: [] });
    const b = engine.createMemory({ claim: "Auth has a hardcoded token equality check", type: "warning", repoScope: "p", sources: [] });
    expect(a.id).not.toBe(b.id);

    const fake = makeFakeGeminiReturning([
      { kind: "merge", sourceIndices: [0, 1], claim: "Auth uses a hardcoded token equality check", type: "warning", language: "typescript", rationale: "Same fact, two wordings" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "p", minMemories: 2 });

    expect(result.merged).toBe(2);
    expect(result.newMemoryIds).toHaveLength(1);
    expect(result.deactivatedIds).toHaveLength(2);
    expect(result.deactivatedIds).toContain(a.id);
    expect(result.deactivatedIds).toContain(b.id);

    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(1);
    const merged = remaining[0];
    expect(merged.claim).toContain("hardcoded token");
    expect(merged.consolidationKind).toBe("merge");
    expect(merged.consolidatedFrom).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(merged.successCount).toBe(0);
    expect(merged.failureCount).toBe(0);

    closeDatabase({ db, dbPath });
  });

  it("compresses a verbose memory into a concise one", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "When running tests, you must first run npm install in the root, and then run the test command. Make sure all dependencies are installed or the test will fail with a module not found error.", type: "procedure", repoScope: "p", sources: [] });

    const fake = makeFakeGeminiReturning([
      { kind: "compress", sourceIndices: [0], claim: "Run npm install before running tests in this repo.", type: "procedure", language: null, rationale: "Verbose claim reduced to single instruction" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "p", minMemories: 1 });

    expect(result.compressed).toBe(1);
    expect(result.newMemoryIds).toHaveLength(1);
    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].claim).toContain("npm install");
    expect(remaining[0].consolidationKind).toBe("compress");

    closeDatabase({ db, dbPath });
  });

  it("synthesizes three related facts into a higher-level pattern", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "Auth tokens expire after 1 hour", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "Refresh tokens last 7 days", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "Refresh tokens can be revoked manually via /api/auth/revoke", type: "fact", repoScope: "p", sources: [] });

    const fake = makeFakeGeminiReturning([
      { kind: "synthesize", sourceIndices: [0, 1, 2], claim: "Auth tokens are short-lived (1h) and refreshable (7d); refresh tokens can be revoked via /api/auth/revoke.", type: "procedure", language: null, rationale: "Three related facts about token lifecycle form a coherent procedure" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "p", minMemories: 2 });

    expect(result.synthesized).toBe(3);
    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].consolidationKind).toBe("synthesize");
    expect(remaining[0].type).toBe("procedure");

    closeDatabase({ db, dbPath });
  });

  it("leaves memories alone when agent returns empty actions", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "a", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "b", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "c", type: "fact", repoScope: "p", sources: [] });

    const fake = makeFakeGeminiReturning([]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "p", minMemories: 2 });

    expect(result.kept).toBe(3);
    expect(result.newMemoryIds).toHaveLength(0);
    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(3);

    closeDatabase({ db, dbPath });
  });

  it("inherits success/failure counts and merges concepts", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    const a = engine.createMemory({ claim: "X", type: "fact", repoScope: "p", sources: [], concepts: JSON.stringify(["auth", "tokens"]) });
    const b = engine.createMemory({ claim: "Y", type: "fact", repoScope: "p", sources: [], concepts: JSON.stringify(["auth", "middleware"]) });
    engine.recordSuccess(a.id);
    engine.recordSuccess(a.id);
    engine.recordFailure(b.id);

    const fake = makeFakeGeminiReturning([
      { kind: "merge", sourceIndices: [0, 1], claim: "X and Y combined", type: "fact", language: null, rationale: "merge" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    await consolidateProject(db, fake as any, { scope: "p", minMemories: 1 });

    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].successCount).toBe(2);
    expect(remaining[0].failureCount).toBe(1);
    const concepts = JSON.parse(remaining[0].concepts ?? "[]");
    expect(concepts).toEqual(expect.arrayContaining(["auth", "tokens", "middleware"]));

    closeDatabase({ db, dbPath });
  });

  it("skips scopes below the min threshold", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "only one", type: "fact", repoScope: "tiny", sources: [] });

    const fake = makeFakeGeminiReturning([
      { kind: "merge", sourceIndices: [0], claim: "should not happen", type: "fact", language: null, rationale: "x" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "tiny", minMemories: 3 });

    expect(result.skipped).toMatch(/below_threshold/);
    expect(result.considered).toBe(0);
    expect(listActiveMemoriesForScope(db, "tiny", 50)).toHaveLength(1);

    closeDatabase({ db, dbPath });
  });

  it("dry-run does not modify the DB", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "a", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "b", type: "fact", repoScope: "p", sources: [] });

    const fake = makeFakeGeminiReturning([
      { kind: "merge", sourceIndices: [0, 1], claim: "ab", type: "fact", language: null, rationale: "x" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    const result = await consolidateProject(db, fake as any, { scope: "p", minMemories: 1, dryRun: true });

    expect(result.merged).toBe(2);
    expect(listActiveMemoriesForScope(db, "p", 50)).toHaveLength(2);
    expect(result.newMemoryIds).toHaveLength(0);

    closeDatabase({ db, dbPath });
  });

  it("is idempotent — running twice does not double-consolidate", async () => {
    const { db } = openDatabase(dbPath);
    const engine = createMemoryEngine(db);
    engine.createMemory({ claim: "a", type: "fact", repoScope: "p", sources: [] });
    engine.createMemory({ claim: "b", type: "fact", repoScope: "p", sources: [] });

    const fake = makeFakeGeminiReturning([
      { kind: "merge", sourceIndices: [0, 1], claim: "ab", type: "fact", language: null, rationale: "x" },
    ]);

    const { consolidateProject } = await import("../src/consolidation/agent.js");
    await consolidateProject(db, fake as any, { scope: "p", minMemories: 1 });
    const result2 = await consolidateProject(db, fake as any, { scope: "p", minMemories: 1 });

    expect(result2.kept).toBe(1);
    expect(result2.newMemoryIds).toHaveLength(0);
    const remaining = listActiveMemoriesForScope(db, "p", 50);
    expect(remaining).toHaveLength(1);

    closeDatabase({ db, dbPath });
  });
});

function makeFakeGeminiReturning(actions: ConsolidationAction[]): FakeGemini & { generateStructured: any } {
  const base = createFakeGemini();
  return {
    ...base,
    async generateStructured(_system: string, _user: string, _schema: unknown) {
      return { actions };
    },
  };
}
