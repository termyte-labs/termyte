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
  it("runs retrieval suite with passing deterministic thresholds", async () => {
    const report = await runEval({ suite: "retrieval" });

    expect(report.suite).toBe("retrieval");
    expect(report.passed, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.metrics.recallAt5).toBeGreaterThanOrEqual(0.85);
    expect(report.metrics.mrr).toBeGreaterThanOrEqual(0.70);
    expect(report.metrics.precisionAt5).toBeGreaterThanOrEqual(0.50);
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
    expect(report.passed).toBe(true);
    expect(report.metrics["retrieval.recallAt5"]).toBeGreaterThanOrEqual(0.85);
  });
});
