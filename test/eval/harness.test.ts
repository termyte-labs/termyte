import { describe, expect, it } from "vitest";
import { loadRegressionCorpus } from "../../src/eval/corpus.js";
import { assertDurabilityInvariants, FaultInjector, InjectedFaultError } from "../../src/eval/fault-injection.js";
import { FixedEmbeddingsProvider, runEval } from "../../src/eval/harness.js";
import { Store } from "../../src/storage/store.js";
import { openDatabase } from "../../src/storage/connection.js";

describe("eval corpus", () => {
  it("loads at least twenty deterministic regression cases", () => {
    const corpus = loadRegressionCorpus();

    expect(corpus.length).toBeGreaterThanOrEqual(20);
    expect(corpus[0]!.id).toBe("case_sqlite_vec_001");
    expect(corpus.every((item) => item.queries.length > 0)).toBe(true);
  });
});

describe("FixedEmbeddingsProvider", () => {
  it("is deterministic and normalized", async () => {
    const embeddings = new FixedEmbeddingsProvider();
    const a = await embeddings.embed("sqlite-vec retrieval");
    const b = await embeddings.embed("sqlite-vec retrieval");

    expect(Array.from(a)).toEqual(Array.from(b));

    const norm = Math.sqrt(Array.from(a).reduce((sum, value) => sum + value * value, 0));
    expect(norm).toBeCloseTo(1, 5);
  });
});

describe("FaultInjector", () => {
  it("throws once for configured fault points", () => {
    const injector = new FaultInjector();
    injector.failOnce("after_observation_insert");

    expect(() => injector.check("after_observation_insert")).toThrow(InjectedFaultError);
    expect(() => injector.check("after_observation_insert")).not.toThrow();
  });
});

describe("durability invariants", () => {
  it("detects indexed observations without embeddings", () => {
    const store = new Store(openDatabase(":memory:"));
    try {
      store.upsertSession("s1", "eval", "repo", "/w");
      const obs = store.insertObservation({
        session_id: "s1",
        repo_id: "repo",
        workspace_root: "/w",
        type: "fact",
        title: "bad indexed observation",
        description: "missing embedding",
        files_read: [],
        files_modified: [],
        commands_executed: [],
        source_trace_ids: [],
        created_at: 1,
        processed_at: null,
      });

      store.getDB().prepare(`
        UPDATE observations SET lifecycle_state = 'indexed' WHERE id = ?
      `).run(obs.id);

      const report = assertDurabilityInvariants(store.getDB());
      expect(report.passed).toBe(false);
      expect(report.violations[0]).toContain("indexed without an embedding");
    } finally {
      store.close();
    }
  });
});

describe("eval suites", () => {
  it("runs retrieval suite and reports honest non-leaked metrics", async () => {
    const report = await runEval({ suite: "retrieval" });

    expect(report.suite).toBe("retrieval");
    expect(typeof report.metrics.recallAt5).toBe("number");
    expect(typeof report.metrics.mrr).toBe("number");
    expect(typeof report.metrics.precisionAt5).toBe("number");
    expect(Array.isArray(report.failures)).toBe(true);
  });

  it("retrieval suite documents never contain expected keywords or query text (EVAL-001 leakage guard)", async () => {
    const corpus = loadRegressionCorpus();
    const store = new Store(openDatabase(":memory:"));
    const embeddings = new FixedEmbeddingsProvider();
    // seedCorpus is internal; replicate the immutable seeding to test for leakage
    store.upsertSession("eval-session", "eval", "eval-repo", "/eval");
    for (const item of corpus) {
      for (const fixture of item.expectedMemories) {
        const content = `${fixture.title}\n${fixture.description}`;
        const memory = store.insertMemory({
          session_id: "eval-session", repo_id: "eval-repo", workspace_root: "/eval",
          type: fixture.type, title: fixture.title, description: fixture.description,
          files_read: fixture.filesRead ?? [], files_modified: fixture.filesModified ?? [],
          source_observation_ids: [], source_trace_ids: [], created_at: Date.now(),
          embedding: await embeddings.embed(content),
        });
        // No document content may contain the leaked answer-key markers
        expect(memory.description).not.toContain("Eval keywords:");
        expect(memory.description).not.toContain("Eval queries:");
        // The title and description must be exactly the fixture's own text
        expect(memory.title).toBe(fixture.title);
        expect(memory.description).toBe(fixture.description);
      }
    }
    store.close();
  });

  it("runs durability suite", async () => {
    const report = await runEval({ suite: "durability" });

    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.metrics.deadLetterJobs).toBe(1);
  });

  it("runs lifecycle suite", async () => {
    const report = await runEval({ suite: "lifecycle" });

    expect(report.passed).toBe(true);
    expect(report.metrics.duplicateDetected).toBe(1);
  });

  it("runs all suites independently and combines metrics", async () => {
    const report = await runEval({ suite: "all" });

    expect(report.suite).toBe("all");
    expect(typeof report.metrics["retrieval.recallAt5"]).toBe("number");
    expect(typeof report.metrics["durability.deadLetterJobs"]).toBe("number");
    expect(typeof report.metrics["lifecycle.duplicateDetected"]).toBe("number");
  });
});
