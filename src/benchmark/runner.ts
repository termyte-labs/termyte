import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateEvaluations, evaluateQuery } from "./metrics.js";
import type { BenchmarkDataset, BenchmarkTrack, MemoryBenchmarkAdapter, QueryEvaluation } from "./types.js";

export interface BenchmarkRunOptions {
  datasetPath?: string;
  dataset?: BenchmarkDataset;
  outputDirectory: string;
  adapter: MemoryBenchmarkAdapter;
  track: BenchmarkTrack;
  seed?: number;
  limit?: number;
  datasetLoader?: (raw: string) => BenchmarkDataset;
}

export async function runBenchmark(options: BenchmarkRunOptions): Promise<Record<string, number>> {
  if (options.track !== "retrieval" && options.track !== "pipeline") {
    throw new Error("Unsupported benchmark track. Expected retrieval or pipeline.");
  }
  if (!options.datasetPath && !options.dataset) throw new Error("A benchmark dataset or dataset path is required.");
  const raw = options.datasetPath
    ? await readFile(resolve(options.datasetPath), "utf8")
    : JSON.stringify(options.dataset);
  const dataset = options.dataset ?? (options.datasetLoader ? options.datasetLoader(raw) : parseDataset(raw));
  validateNoAnswerLeakage(dataset);
  const output = resolve(options.outputDirectory);
  await mkdir(output, { recursive: true });

  const startedAt = new Date().toISOString();
  const startRss = process.memoryUsage().rss;
  await options.adapter.reset();
  const ingestStart = performance.now();
  await options.adapter.ingest(dataset.documents);
  const ingestMs = performance.now() - ingestStart;
  const rows: QueryEvaluation[] = [];
  try {
    for (const query of dataset.queries) {
      const started = performance.now();
      const results = await options.adapter.search(query.query, options.limit ?? 10, { scope: query.scope });
      rows.push(evaluateQuery(query, results.map((result) => result.documentId), performance.now() - started));
    }
    const metrics = {
      ...aggregateEvaluations(rows),
      documents: dataset.documents.length,
      ingest_ms: ingestMs,
      ingest_documents_per_second: ingestMs === 0 ? 0 : dataset.documents.length / (ingestMs / 1000),
    };
    const failures = rows.filter((row) => (row.recallAt["5"] ?? 0) < 1 || row.harmfulRecall > 0);
    const manifest = {
      schemaVersion: 1,
      dataset: { name: dataset.name, version: dataset.version, suite: dataset.suite },
      datasetSha256: createHash("sha256").update(raw).digest("hex"),
      adapter: options.adapter.name,
      track: options.track,
      seed: options.seed ?? 42,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    await Promise.all([
      writeFile(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n"),
      writeFile(join(output, "queries.ndjson"), rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
      writeFile(join(output, "failures.ndjson"), failures.map((row) => JSON.stringify(row)).join("\n") + (failures.length ? "\n" : "")),
      writeFile(join(output, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n"),
      writeFile(join(output, "resource-usage.json"), JSON.stringify({
        rss_start_bytes: startRss,
        rss_end_bytes: process.memoryUsage().rss,
        adapter: await options.adapter.stats(),
      }, null, 2) + "\n"),
      writeFile(join(output, "report.md"), renderReport(dataset, options.adapter.name, metrics, failures.length)),
    ]);
    return metrics;
  } finally {
    await options.adapter.close();
  }
}

export function parseDataset(raw: string): BenchmarkDataset {
  const value = JSON.parse(raw) as Partial<BenchmarkDataset>;
  if (!value.name || !value.version || !value.suite || !Array.isArray(value.documents) || !Array.isArray(value.queries)) {
    throw new Error("Invalid benchmark dataset: name, version, suite, documents, and queries are required.");
  }
  const documentIds = new Set<string>();
  for (const document of value.documents) {
    if (!document.id || !document.content || documentIds.has(document.id)) throw new Error(`Invalid or duplicate document id: ${document.id}`);
    documentIds.add(document.id);
  }
  for (const query of value.queries) {
    if (!query.id || !query.query || !Array.isArray(query.relevantDocumentIds)) throw new Error(`Invalid query: ${query.id}`);
    for (const id of [...query.relevantDocumentIds, ...(query.harmfulDocumentIds ?? [])]) {
      if (!documentIds.has(id)) throw new Error(`Query ${query.id} references unknown document ${id}`);
    }
  }
  return value as BenchmarkDataset;
}

export function validateNoAnswerLeakage(dataset: BenchmarkDataset): void {
  for (const document of dataset.documents) {
    const metadata = JSON.stringify(document.metadata ?? {}).toLowerCase();
    if (/expected(query|keyword|answer)|relevantdocumentids|answer.?key/.test(metadata)) {
      throw new Error(`Answer-key leakage found in document metadata: ${document.id}`);
    }
  }
}

function renderReport(dataset: BenchmarkDataset, adapter: string, metrics: Record<string, number>, failures: number): string {
  return `# Benchmark Report\n\n- Dataset: ${dataset.name} ${dataset.version}\n- Suite: ${dataset.suite}\n- Adapter: ${adapter}\n- Documents: ${dataset.documents.length}\n- Queries: ${dataset.queries.length}\n- Recall@5: ${(metrics["recall_at_5"] ?? 0).toFixed(4)}\n- MRR: ${(metrics["mrr"] ?? 0).toFixed(4)}\n- NDCG@10: ${(metrics["ndcg_at_10"] ?? 0).toFixed(4)}\n- Harmful recall: ${(metrics["harmful_recall"] ?? 0).toFixed(4)}\n- Query latency p50: ${(metrics["latency_p50_ms"] ?? 0).toFixed(2)} ms\n- Query latency p95: ${(metrics["latency_p95_ms"] ?? 0).toFixed(2)} ms\n- Query latency p99: ${(metrics["latency_p99_ms"] ?? 0).toFixed(2)} ms\n- Failed queries: ${failures}\n`;
}
