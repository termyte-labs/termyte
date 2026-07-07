import type { BenchmarkQuery, QueryEvaluation } from "./types.js";

const CUTOFFS = [1, 5, 10] as const;

export function evaluateQuery(
  query: BenchmarkQuery,
  returnedDocumentIds: string[],
  latencyMs: number,
): QueryEvaluation {
  const relevant = new Set(query.relevantDocumentIds);
  const harmful = new Set(query.harmfulDocumentIds ?? []);
  const recallAt: Record<string, number> = {};
  const precisionAt: Record<string, number> = {};
  for (const k of CUTOFFS) {
    const top = returnedDocumentIds.slice(0, k);
    const hits = top.filter((id) => relevant.has(id)).length;
    recallAt[String(k)] = relevant.size === 0 ? (top.length === 0 ? 1 : 0) : hits / relevant.size;
    precisionAt[String(k)] = top.length === 0 ? (relevant.size === 0 ? 1 : 0) : hits / top.length;
  }
  const firstRelevant = returnedDocumentIds.findIndex((id) => relevant.has(id));
  const harmfulHits = returnedDocumentIds.slice(0, 10).filter((id) => harmful.has(id)).length;
  return {
    queryId: query.id,
    query: query.query,
    relevantDocumentIds: [...query.relevantDocumentIds],
    harmfulDocumentIds: [...harmful],
    returnedDocumentIds,
    latencyMs,
    recallAt,
    precisionAt,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
    ndcgAt10: ndcg(returnedDocumentIds.slice(0, 10), relevant),
    abstentionCorrect: relevant.size > 0 || returnedDocumentIds.length === 0,
    harmfulRecall: harmful.size === 0 ? 0 : harmfulHits / harmful.size,
  };
}

export function aggregateEvaluations(rows: readonly QueryEvaluation[]): Record<string, number> {
  const mean = (pick: (row: QueryEvaluation) => number): number =>
    rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  const sortedLatencies = rows.map((row) => row.latencyMs).sort((a, b) => a - b);
  return {
    queries: rows.length,
    recall_at_1: mean((row) => row.recallAt["1"] ?? 0),
    recall_at_5: mean((row) => row.recallAt["5"] ?? 0),
    recall_at_10: mean((row) => row.recallAt["10"] ?? 0),
    precision_at_5: mean((row) => row.precisionAt["5"] ?? 0),
    mrr: mean((row) => row.reciprocalRank),
    ndcg_at_10: mean((row) => row.ndcgAt10),
    abstention_accuracy: mean((row) => row.abstentionCorrect ? 1 : 0),
    harmful_recall: mean((row) => row.harmfulRecall),
    latency_p50_ms: percentile(sortedLatencies, 0.5),
    latency_p95_ms: percentile(sortedLatencies, 0.95),
    latency_p99_ms: percentile(sortedLatencies, 0.99),
  };
}

function ndcg(returned: readonly string[], relevant: ReadonlySet<string>): number {
  let dcg = 0;
  for (let index = 0; index < returned.length; index++) {
    if (relevant.has(returned[index]!)) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(relevant.size, returned.length); index++) {
    ideal += 1 / Math.log2(index + 2);
  }
  return ideal === 0 ? (relevant.size === 0 ? 1 : 0) : dcg / ideal;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}
