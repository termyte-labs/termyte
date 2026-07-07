import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TermyteFtsBenchmarkAdapter } from "../src/benchmark/adapters/termyte-fts.js";
import { evaluateQuery } from "../src/benchmark/metrics.js";
import { runBenchmark, validateNoAnswerLeakage } from "../src/benchmark/runner.js";
import { loadLongMemEval } from "../src/benchmark/datasets/longmemeval.js";
import { generateScaleDataset } from "../src/benchmark/datasets/scale.js";

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe("benchmark framework", () => {
  it("computes retrieval and harm metrics from immutable judgments", () => {
    const row = evaluateQuery({
      id: "q1", query: "auth token", relevantDocumentIds: ["good"], harmfulDocumentIds: ["stale"],
    }, ["stale", "good"], 2);
    expect(row.recallAt["5"]).toBe(1);
    expect(row.reciprocalRank).toBe(0.5);
    expect(row.harmfulRecall).toBe(1);
  });

  it("rejects answer-key fields embedded in candidate metadata", () => {
    expect(() => validateNoAnswerLeakage({
      name: "bad", version: "1", suite: "custom",
      documents: [{ id: "d1", content: "text", metadata: { expectedKeywords: ["secret"] } }],
      queries: [],
    })).toThrow(/leakage/i);
  });

  it("writes a reproducible artifact bundle", async () => {
    directory = await mkdtemp(join(tmpdir(), "termyte-bench-"));
    const datasetPath = join(directory, "dataset.json");
    const output = join(directory, "output");
    await writeFile(datasetPath, JSON.stringify({
      name: "smoke", version: "1", suite: "custom",
      documents: [
        { id: "auth", title: "JWT authentication", content: "The API validates JWT bearer tokens." },
        { id: "db", title: "SQLite storage", content: "The application stores rows in SQLite." },
      ],
      queries: [{ id: "q1", query: "JWT bearer authentication", relevantDocumentIds: ["auth"] }],
    }));
    const metrics = await runBenchmark({
      datasetPath, outputDirectory: output, adapter: new TermyteFtsBenchmarkAdapter(), track: "retrieval",
    });
    expect(metrics["recall_at_5"]).toBe(1);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest.datasetSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const file of ["queries.ndjson", "failures.ndjson", "metrics.json", "resource-usage.json", "report.md"]) {
      expect(await readFile(join(output, file), "utf8")).toBeDefined();
    }
  });

  it("runs the pipeline track and records the track in the artifact bundle", async () => {
    directory = await mkdtemp(join(tmpdir(), "termyte-bench-"));
    const datasetPath = join(directory, "dataset.json");
    const output = join(directory, "pipeline-output");
    await writeFile(datasetPath, JSON.stringify({
      name: "smoke-pipeline", version: "1", suite: "custom",
      documents: [
        { id: "auth", title: "JWT authentication", content: "The API validates JWT bearer tokens." },
        { id: "db", title: "SQLite storage", content: "The application stores rows in SQLite." },
      ],
      queries: [{ id: "q1", query: "JWT bearer authentication", relevantDocumentIds: ["auth"] }],
    }));
    const metrics = await runBenchmark({
      datasetPath,
      outputDirectory: output,
      adapter: new TermyteFtsBenchmarkAdapter(),
      track: "pipeline",
    });
    expect(metrics["recall_at_5"]).toBe(1);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest.track).toBe("pipeline");
  });

  it("normalizes LongMemEval with isolated per-question haystacks", () => {
    const dataset = loadLongMemEval(JSON.stringify([{
      question_id: "q1", question_type: "single-session-user", question: "Which editor?",
      answer_session_ids: ["s1"], haystack_session_ids: ["s1", "s2"],
      haystack_sessions: [
        [{ role: "user", content: "I use Neovim." }],
        [{ role: "user", content: "I use SQLite." }],
      ],
    }]));
    expect(dataset.documents.map((document) => document.id)).toEqual(["q1::s1", "q1::s2"]);
    expect(dataset.documents.every((document) => document.scope === "q1")).toBe(true);
    expect(dataset.queries[0]!.relevantDocumentIds).toEqual(["q1::s1"]);
    expect(dataset.queries[0]!.scope).toBe("q1");
  });

  it("generates reproducible independently labeled scale corpora", () => {
    const first = generateScaleDataset(100, 7);
    const second = generateScaleDataset(100, 7);
    expect(first).toEqual(second);
    expect(first.documents).toHaveLength(100);
    expect(first.queries).toHaveLength(10);
    expect(first.queries[0]!.relevantDocumentIds).toHaveLength(1);
  });
});
