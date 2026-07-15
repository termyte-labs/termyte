import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TermyteFtsBenchmarkAdapter } from "../src/benchmark/adapters/termyte-fts.js";
import { TermytePipelineBenchmarkAdapter } from "../src/benchmark/adapters/termyte-pipeline.js";
import { compareBenchmarkRuns, loadBenchmarkRunSummary, renderComparisonReport } from "../src/benchmark/comparison.js";
import { loadMemoryAgentBenchDataset } from "../src/benchmark/datasets/memoryagentbench.js";
import { evaluateQuery } from "../src/benchmark/metrics.js";
import { runBenchmark, validateNoAnswerLeakage } from "../src/benchmark/runner.js";
import { loadRawSessionDataset } from "../src/benchmark/datasets/raw-session.js";
import { generateScaleDataset } from "../src/benchmark/datasets/scale.js";
import { loadCompetitorExecutionAdapters } from "../src/benchmark/competitor-executions.js";
import { planCompetitorBenchmarkRun, runCompetitorBenchmark } from "../src/benchmark/competitor-executions.js";
import { loadCompetitorRunArtifacts } from "../src/benchmark/competitor-runs.js";

let directory: string | undefined;
const root = fileURLToPath(new URL("..", import.meta.url));
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
      adapter: new TermytePipelineBenchmarkAdapter(),
      track: "pipeline",
    });
    expect(metrics["recall_at_5"]).toBe(1);
    expect(metrics["latency_p99_ms"]).toBeGreaterThanOrEqual(0);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest.track).toBe("pipeline");
    expect(await readFile(join(output, "report.md"), "utf8")).toContain("Query latency p99");
  });

  it("normalizes raw session transcripts into a pipeline-friendly dataset", () => {
    const dataset = loadRawSessionDataset(JSON.stringify([{
      session_id: "s1",
      project: "demo",
      turns: [
        { role: "user", content: "We need to validate JWT bearer tokens.", files: ["src/auth/token.ts"] },
        { role: "assistant", content: "I updated the auth middleware." },
      ],
      queries: [
        { id: "q1", query: "JWT bearer tokens", relevant_turn_indexes: [0] },
      ],
    }]));

    expect(dataset.suite).toBe("raw-session");
    expect(dataset.documents).toHaveLength(2);
    expect(dataset.documents[0]!.scope).toBe("s1");
    expect(dataset.queries[0]!.relevantDocumentIds).toEqual(["s1::turn_000"]);
  });

  it("normalizes MemoryAgentBench contexts into benchmark documents", () => {
    const dataset = loadMemoryAgentBenchDataset(JSON.stringify([{
      sample_id: "sample-1",
      context: [
        "We refactored the auth middleware.",
        "JWT bearer tokens are validated before protected routes.",
      ],
      query_and_answers: [
        { qa_pair_id: "qa-1", query: "What validates JWT bearer tokens?", answer: "The auth middleware." },
      ],
    }]));

    expect(dataset.suite).toBe("memoryagent");
    expect(dataset.documents).toHaveLength(2);
    expect(dataset.documents[0]!.scope).toBe("sample-1");
    expect(dataset.queries[0]!.relevantDocumentIds).toEqual(["sample-1::chunk_000"]);
  });

  it("loads the checked-in MemoryAgentBench smoke contract", async () => {
    const raw = await readFile(join(root, "test", "fixtures", "benchmarks", "memoryagentbench-smoke.json"), "utf8");
    const dataset = loadMemoryAgentBenchDataset(raw);

    expect(dataset.documents).toHaveLength(4);
    expect(dataset.queries.map((query) => query.id)).toEqual(["mab-auth-question", "mab-worker-question"]);
    expect(dataset.queries[1]!.relevantDocumentIds).toEqual(["mab-worker::chunk_000"]);
  });

  it("rejects MemoryAgentBench rows without context using the stable row id", () => {
    expect(() => loadMemoryAgentBenchDataset(JSON.stringify([{
      sample_id: "missing-context", query_and_answers: [{ qa_pair_id: "q1", question: "What happened?", answer: "Nothing." }],
    }]))).toThrow(/missing-context.*context chunks/i);
  });

  it("runs the MemoryAgentBench smoke fixture end to end", async () => {
    directory = await mkdtemp(join(tmpdir(), "termyte-memoryagentbench-"));
    const raw = await readFile(join(root, "test", "fixtures", "benchmarks", "memoryagentbench-smoke.json"), "utf8");
    const metrics = await runBenchmark({
      dataset: loadMemoryAgentBenchDataset(raw), outputDirectory: directory,
      adapter: new TermyteFtsBenchmarkAdapter(), track: "retrieval",
    });

    expect(metrics["recall_at_5"]).toBe(1);
  });

  it("runs the raw-session pipeline track end to end", async () => {
    directory = await mkdtemp(join(tmpdir(), "termyte-bench-"));
    const output = join(directory, "raw-session-output");
    const dataset = {
      name: "raw-session-smoke",
      version: "1",
      suite: "raw-session",
      sessions: [
        {
          session_id: "s1",
          project: "demo",
          turns: [
            { role: "user", content: "We need to validate JWT bearer tokens.", files: ["src/auth/token.ts"] },
            { role: "assistant", content: "I updated the auth middleware." },
          ],
          queries: [
            { id: "q1", query: "JWT bearer tokens", relevant_turn_indexes: [0] },
          ],
        },
      ],
    };

    const metrics = await runBenchmark({
      dataset: loadRawSessionDataset(JSON.stringify(dataset.sessions)),
      outputDirectory: output,
      adapter: new TermytePipelineBenchmarkAdapter(),
      track: "pipeline",
    });

    expect(metrics["recall_at_5"]).toBe(1);
    expect(metrics["latency_p99_ms"]).toBeGreaterThanOrEqual(0);
    const manifest = JSON.parse(await readFile(join(output, "manifest.json"), "utf8"));
    expect(manifest.dataset.suite).toBe("raw-session");
    expect(await readFile(join(output, "report.md"), "utf8")).toContain("Query latency p99");
  });

  it("renders a comparison report across benchmark runs", async () => {
    directory = await mkdtemp(join(tmpdir(), "termyte-bench-"));
    const first = join(directory, "first");
    const second = join(directory, "second");
    const output = join(directory, "comparison");
    await Promise.all([
      mkdir(first, { recursive: true }),
      mkdir(second, { recursive: true }),
    ]);
    await writeFile(join(first, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      dataset: { name: "run-a", version: "1", suite: "custom" },
      adapter: "fts",
      track: "retrieval",
    }, null, 2) + "\n");
    await writeFile(join(first, "metrics.json"), JSON.stringify({
      recall_at_5: 0.4,
      mrr: 0.25,
      ndcg_at_10: 0.3,
      harmful_recall: 0,
      latency_p99_ms: 14,
    }, null, 2) + "\n");
    await writeFile(join(second, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      dataset: { name: "run-b", version: "1", suite: "custom" },
      adapter: "termyte",
      track: "retrieval",
    }, null, 2) + "\n");
    await writeFile(join(second, "metrics.json"), JSON.stringify({
      recall_at_5: 1,
      mrr: 0.8,
      ndcg_at_10: 0.9,
      harmful_recall: 0,
      latency_p99_ms: 2,
    }, null, 2) + "\n");

    await compareBenchmarkRuns([first, second], output);
    const report = await readFile(join(output, "comparison.md"), "utf8");
    const summaries = await Promise.all([loadBenchmarkRunSummary(first), loadBenchmarkRunSummary(second)]);
    expect(report).toContain("# Benchmark Comparison");
    expect(report).toContain("Dataset suite: custom");
    expect(report.indexOf("termyte")).toBeLessThan(report.indexOf("fts"));
    expect(renderComparisonReport(summaries)).toBe(report);
  });

  it("renders competitor execution adapters in comparison reports", async () => {
    const adapters = await loadCompetitorExecutionAdapters("C:/Users/Palguna/Desktop/competitors");
    const runs = await loadCompetitorRunArtifacts("C:/Users/Palguna/Desktop/competitors");
    const report = renderComparisonReport([
      {
        directory: "run-a",
        manifest: {
          dataset: { name: "run-a", version: "1", suite: "custom" },
          adapter: "fts",
          track: "retrieval",
        },
        metrics: { recall_at_5: 0.5, mrr: 0.25, ndcg_at_10: 0.3, harmful_recall: 0, latency_p99_ms: 10 },
      },
      {
        directory: "run-b",
        manifest: {
          dataset: { name: "run-b", version: "1", suite: "custom" },
          adapter: "termyte",
          track: "retrieval",
        },
        metrics: { recall_at_5: 1, mrr: 0.8, ndcg_at_10: 0.9, harmful_recall: 0, latency_p99_ms: 2 },
      },
    ], [], adapters, runs);

    expect(report).toContain("## Competitor Execution Adapters");
    expect(report).toContain("## Published Competitor Runs");
    expect(report).toContain("agentmemory");
    expect(report).toContain("claude-mem");
  });

  it("includes published competitor baselines when a competitor root is provided", async () => {
    const baselines = await (await import("../src/benchmark/competitors.js")).loadPublishedBaselines("C:/Users/Palguna/Desktop/competitors");
    expect(baselines.some((baseline) => baseline.source === "mem0" && baseline.benchmark === "BEAM (1M)")).toBe(true);
    expect(baselines.some((baseline) => baseline.source === "mem0" && baseline.benchmark === "BEAM (10M)")).toBe(true);
    expect(baselines.some((baseline) => baseline.source === "claude-mem" && baseline.benchmark === "Smart Explore")).toBe(true);
  });

  it("describes competitor execution adapters from local checkouts", async () => {
    const adapters = await loadCompetitorExecutionAdapters("C:/Users/Palguna/Desktop/competitors");
    const agentmemory = adapters.find((adapter) => adapter.source === "agentmemory");
    const mem0 = adapters.find((adapter) => adapter.source === "mem0");
    const claudeMem = adapters.find((adapter) => adapter.source === "claude-mem");

    expect(agentmemory?.executable).toBe(true);
    expect(agentmemory?.commands).toContain("npm run bench:quality");
    expect(agentmemory?.publicArtifacts).toContain("benchmark/QUALITY.md");
    expect(mem0?.executable).toBe(true);
    expect(mem0?.commands.some((command) => command.includes("benchmarks.beam.run"))).toBe(true);
    expect(claudeMem?.executable).toBe(false);
    expect(claudeMem?.publicArtifacts).toContain("docs/public/smart-explore-benchmark.mdx");
  });

  it("resolves runnable competitor benchmark plans and guards missing submodules", async () => {
    const agentmemoryPlan = await planCompetitorBenchmarkRun({
      source: "agentmemory",
      benchmark: "quality",
      rootDirectory: "C:/Users/Palguna/Desktop/competitors",
      dryRun: true,
    });
    expect(agentmemoryPlan.executable).toBe(true);
    expect(agentmemoryPlan.command).toMatch(/npm(\.cmd)?$/);
    expect(agentmemoryPlan.args).toContain("bench:quality");
    expect(agentmemoryPlan.expectedArtifacts).toContain("benchmark/QUALITY.md");

    const mem0Plan = await planCompetitorBenchmarkRun({
      source: "mem0",
      benchmark: "beam",
      rootDirectory: "C:/Users/Palguna/Desktop/competitors",
      projectName: "termyte-bench",
      backend: "oss",
      dryRun: true,
    });
    expect(mem0Plan.executable).toBe(true);
    expect(mem0Plan.command).toMatch(/python(\.exe|3)?$/i);
    expect(mem0Plan.args).toContain("benchmarks.beam.run");
    expect(mem0Plan.reason).toBeUndefined();

    const claudePlan = await planCompetitorBenchmarkRun({
      source: "claude-mem",
      benchmark: "beam",
      rootDirectory: "C:/Users/Palguna/Desktop/competitors",
      dryRun: true,
    });
    expect(claudePlan.executable).toBe(false);
    expect(claudePlan.reason).toMatch(/no local benchmark runner/i);
  });

  it("returns a dry-run result for unsupported competitor execution", async () => {
    const result = await runCompetitorBenchmark({
      source: "claude-mem",
      benchmark: "beam",
      rootDirectory: "C:/Users/Palguna/Desktop/competitors",
      dryRun: true,
    });
    expect(result.exitCode).toBe(1);
    expect(result.plan.executable).toBe(false);
  });

  it("loads published competitor run artifacts from local checkouts", async () => {
    const runs = await loadCompetitorRunArtifacts("C:/Users/Palguna/Desktop/competitors");
    expect(runs.some((run) => run.source === "mem0" && run.benchmark === "BEAM (1M)")).toBe(true);
    expect(runs.some((run) => run.source === "mem0" && run.benchmark === "BEAM (10M)")).toBe(true);
    expect(runs.some((run) => run.source === "claude-mem" && run.benchmark === "Discovery")).toBe(true);
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
