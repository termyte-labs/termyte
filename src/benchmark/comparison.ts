import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface BenchmarkRunSummary {
  directory: string;
  manifest: {
    dataset: {
      name: string;
      version: string;
      suite: string;
    };
    adapter: string;
    track: string;
    startedAt?: string;
    completedAt?: string;
  };
  metrics: Record<string, number>;
}

export async function loadBenchmarkRunSummary(directory: string): Promise<BenchmarkRunSummary> {
  const resolved = resolve(directory);
  const [manifestRaw, metricsRaw] = await Promise.all([
    readFile(join(resolved, "manifest.json"), "utf8"),
    readFile(join(resolved, "metrics.json"), "utf8"),
  ]);

  const manifest = JSON.parse(manifestRaw) as Partial<BenchmarkRunSummary["manifest"]>;
  if (!manifest.dataset?.name || !manifest.dataset?.version || !manifest.dataset?.suite || !manifest.adapter || !manifest.track) {
    throw new Error(`Invalid benchmark manifest in ${resolved}.`);
  }

  return {
    directory: resolved,
    manifest: {
      dataset: manifest.dataset,
      adapter: manifest.adapter,
      track: manifest.track,
      startedAt: manifest.startedAt,
      completedAt: manifest.completedAt,
    },
    metrics: JSON.parse(metricsRaw) as Record<string, number>,
  };
}

export async function compareBenchmarkRuns(runDirectories: string[], outputDirectory: string): Promise<{ runs: BenchmarkRunSummary[] }> {
  if (runDirectories.length < 2) {
    throw new Error("Benchmark comparison requires at least two run directories.");
  }

  const runs = await Promise.all(runDirectories.map((directory) => loadBenchmarkRunSummary(directory)));
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true });

  await Promise.all([
    writeFile(join(output, "comparison.json"), JSON.stringify({ runs }, null, 2) + "\n"),
    writeFile(join(output, "comparison.md"), renderComparisonReport(runs)),
  ]);

  return { runs };
}

export function renderComparisonReport(runs: BenchmarkRunSummary[]): string {
  const ordered = [...runs].sort((left, right) => {
    const recallDelta = (right.metrics["recall_at_5"] ?? 0) - (left.metrics["recall_at_5"] ?? 0);
    if (recallDelta !== 0) return recallDelta;
    const mrrDelta = (right.metrics["mrr"] ?? 0) - (left.metrics["mrr"] ?? 0);
    if (mrrDelta !== 0) return mrrDelta;
    return (left.metrics["latency_p99_ms"] ?? Number.POSITIVE_INFINITY) - (right.metrics["latency_p99_ms"] ?? Number.POSITIVE_INFINITY);
  });
  const baseline = ordered[0];
  const lines = [
    "# Benchmark Comparison",
    "",
    `- Baseline: ${baseline.manifest.dataset.name} / ${baseline.manifest.adapter}`,
    `- Dataset suite: ${baseline.manifest.dataset.suite}`,
    `- Runs: ${ordered.length}`,
    "",
    "| Adapter | Track | Recall@5 | MRR | NDCG@10 | Harmful recall | p99 ms | Delta Recall@5 |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
  ];

  for (const run of ordered) {
    const recall = run.metrics["recall_at_5"] ?? 0;
    const baselineRecall = baseline.metrics["recall_at_5"] ?? 0;
    lines.push([
      run.manifest.adapter,
      run.manifest.track,
      formatMetric(recall),
      formatMetric(run.metrics["mrr"] ?? 0),
      formatMetric(run.metrics["ndcg_at_10"] ?? 0),
      formatMetric(run.metrics["harmful_recall"] ?? 0),
      formatMetric(run.metrics["latency_p99_ms"] ?? 0),
      formatMetric(recall - baselineRecall),
    ].map(escapeCell).join(" | ") + " |");
  }

  lines.push("", "## Runs");
  for (const run of ordered) {
    lines.push(
      "",
      `### ${run.manifest.adapter}`,
      `- Dataset: ${run.manifest.dataset.name} ${run.manifest.dataset.version}`,
      `- Suite: ${run.manifest.dataset.suite}`,
      `- Track: ${run.manifest.track}`,
      `- Directory: ${run.directory}`,
    );
  }

  return lines.join("\n") + "\n";
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}
