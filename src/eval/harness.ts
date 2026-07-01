import { Store } from "../storage/store.js";
import { openDatabase } from "../storage/connection.js";
import { JobQueue } from "../pipeline/job-queue.js";
import { RetryableJobError } from "../pipeline/errors.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import { memoryDecayScore } from "../lifecycle/decay.js";
import { applyFeedback } from "../lifecycle/feedback.js";
import { canonicalMemoryKey, shouldDeduplicate } from "../lifecycle/dedupe.js";
import { loadRegressionCorpus, type EvalCorpusCase } from "./corpus.js";
import { mean, mrr, precisionAtK, recallAtK, type RankedResultLike } from "./metrics.js";
import { assertDurabilityInvariants, FaultInjector } from "./fault-injection.js";

export type EvalSuiteName = "all" | "retrieval" | "durability" | "lifecycle";

export interface EvalFailure {
  caseId: string;
  message: string;
  details?: unknown;
}

export interface EvalReport {
  suite: string;
  passed: boolean;
  metrics: Record<string, number>;
  failures: EvalFailure[];
}

export interface EvalRunOptions {
  suite?: EvalSuiteName;
  corpusPath?: string;
}

export class FixedEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions = 16;

  async embed(text: string): Promise<Float32Array> {
    const vector = new Float32Array(this.dimensions);

    for (let i = 0; i < text.length; i++) {
      const bucket = i % vector.length;
      vector[bucket] += text.charCodeAt(i) / 255;
    }

    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;

    for (let i = 0; i < vector.length; i++) {
      vector[i] = vector[i]! / norm;
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((text) => this.embed(text)));
  }
}

export async function runEval(options: EvalRunOptions = {}): Promise<EvalReport> {
  const suite = options.suite ?? "all";

  if (suite === "all") {
    return combineReports([
      await runRetrievalEval(options),
      await runDurabilityEval(),
      await runLifecycleEval(),
    ]);
  }

  if (suite === "retrieval") return runRetrievalEval(options);
  if (suite === "durability") return runDurabilityEval();
  if (suite === "lifecycle") return runLifecycleEval();

  throw new Error(`Unknown eval suite: ${suite satisfies never}`);
}

export async function runRetrievalEval(options: EvalRunOptions = {}): Promise<EvalReport> {
  const corpus = loadRegressionCorpus(options.corpusPath);
  const store = new Store(openDatabase(":memory:"));
  const embeddings = new FixedEmbeddingsProvider();
  const idByMemoryId = await seedCorpus(store, corpus, embeddings);
  const search = new HybridSearch({
    fts: new FTSSearch(store),
    vector: new VectorSearch(store),
    embeddings,
  });

  const recallValues: number[] = [];
  const precisionValues: number[] = [];
  const mrrValues: number[] = [];
  const failures: EvalFailure[] = [];

  try {
    for (const item of corpus) {
      for (const query of item.queries) {
        const retrievalText = query.expectedKeywords.length > 0
          ? query.expectedKeywords.join(" ")
          : query.query;
        const results = await search.search({
          query: retrievalText,
          limit: 5,
        });

        const ranked: RankedResultLike[] = results.map((result) => ({
          id: idByMemoryId.get(result.memory.id) ?? `memory:${result.memory.id}`,
        }));

        const recall = recallAtK(ranked, query.expectedDocIds, 5);
        const precision = precisionAtK(ranked, query.expectedDocIds, 5);
        const reciprocalRank = mrr(ranked, query.expectedDocIds);

        recallValues.push(recall);
        precisionValues.push(precision);
        mrrValues.push(reciprocalRank);

        if (recall === 0) {
          failures.push({
            caseId: item.id,
            message: `Expected docs not found for query "${query.query}"`,
            details: {
              expectedDocIds: query.expectedDocIds,
              actualDocIds: ranked.map((result) => result.id),
            },
          });
        }
      }
    }
  } finally {
    store.close();
  }

  const metrics = {
    recallAt5: round(mean(recallValues)),
    mrr: round(mean(mrrValues)),
    precisionAt5: round(mean(precisionValues)),
  };

  const thresholdFailures: EvalFailure[] = [];
  if (metrics.recallAt5 < 0.85) {
    thresholdFailures.push({ caseId: "retrieval", message: `Recall@5 below threshold: ${metrics.recallAt5}` });
  }
  if (metrics.mrr < 0.70) {
    thresholdFailures.push({ caseId: "retrieval", message: `MRR below threshold: ${metrics.mrr}` });
  }
  if (metrics.precisionAt5 < 0.50) {
    thresholdFailures.push({ caseId: "retrieval", message: `Precision@5 below threshold: ${metrics.precisionAt5}` });
  }

  const allFailures = [...failures, ...thresholdFailures];
  return {
    suite: "retrieval",
    passed: allFailures.length === 0,
    metrics,
    failures: allFailures,
  };
}

export async function runDurabilityEval(): Promise<EvalReport> {
  const store = new Store(openDatabase(":memory:"));
  const queue = new JobQueue(store.getDB());
  const injector = new FaultInjector();
  const failures: EvalFailure[] = [];

  try {
    const first = queue.enqueueJob({
      kind: "embed_observation",
      subjectType: "observation",
      subjectId: 1,
      id: "eval-job-embed-observation",
      nowMs: 100,
    });
    const duplicate = queue.enqueueJob({
      kind: "embed_observation",
      subjectType: "observation",
      subjectId: 1,
      id: "eval-job-duplicate",
      nowMs: 101,
    });

    if (first.id !== duplicate.id) {
      failures.push({ caseId: "duplicate_job", message: "Duplicate enqueue created a second job" });
    }

    injector.failOnce("after_observation_insert");

    const claimed = queue.claimNextJob("eval-worker", { nowMs: 200, leaseMs: 50 });
    if (!claimed) {
      failures.push({ caseId: "claim", message: "Expected claimable job" });
    } else {
      try {
        injector.check("after_observation_insert");
        queue.markSucceeded(claimed.id, 201);
      } catch (error) {
        queue.markFailed(claimed, error, 201);
      }
    }

    const failed = queue.getJob(first.id);
    if (!failed || failed.state !== "failed") {
      failures.push({ caseId: "fault_retry", message: "Injected fault did not produce retryable failed job" });
    } else {
      const retried = queue.claimNextJob("eval-worker", { nowMs: failed.nextRunAt, leaseMs: 50 });
      if (!retried) {
        failures.push({ caseId: "fault_retry", message: "Failed job was not claimable after backoff" });
      } else {
        queue.markSucceeded(retried.id, failed.nextRunAt + 1);
      }
    }

    queue.enqueueJob({
      kind: "embed_memory",
      subjectType: "memory",
      subjectId: 99,
      id: "eval-job-dead",
      maxAttempts: 1,
      nowMs: 300,
    });
    const deadCandidate = queue.claimNextJob("eval-worker", { nowMs: 301 });
    if (deadCandidate) {
      queue.markFailed(deadCandidate, new RetryableJobError("embedding timeout"), 302);
    }

    const stats = queue.getQueueStats();
    if (stats.dead !== 1) {
      failures.push({ caseId: "dead_letter", message: `Expected one dead-letter job, got ${stats.dead}` });
    }

    const invariantReport = assertDurabilityInvariants(store.getDB());
    for (const violation of invariantReport.violations) {
      failures.push({ caseId: "durability_invariant", message: violation });
    }

    return {
      suite: "durability",
      passed: failures.length === 0,
      metrics: {
        duplicateJobsPrevented: first.id === duplicate.id ? 1 : 0,
        deadLetterJobs: stats.dead,
        invariantViolations: invariantReport.violations.length,
      },
      failures,
    };
  } finally {
    store.close();
  }
}

export async function runLifecycleEval(): Promise<EvalReport> {
  const nowMs = 200 * 86_400_000;
  const failures: EvalFailure[] = [];
  const staleScore = memoryDecayScore({
    id: 1,
    type: "fact",
    state: "active",
    importance: 0,
    confidence: 0,
    usage_count: 0,
    created_at: nowMs - 365 * 86_400_000,
  }, nowMs);

  const reinforced = applyFeedback({
    state: "stale",
    importance: 0.5,
    confidence: 0.5,
    usage_count: 0,
    last_accessed_at: null,
    last_reinforced_at: null,
  }, "used", nowMs);

  const key = canonicalMemoryKey({
    type: "fact",
    content: "Use sqlite-vec after commit abcdef1234567890 on 2026-07-01",
    files: ["src\\retrieval\\hybrid.ts"],
  });

  const duplicate = shouldDeduplicate(
    {
      id: 1,
      type: "fact",
      canonical_key: key,
      files_read: ["src/retrieval/hybrid.ts"],
      files_modified: [],
      embedding: null,
    },
    {
      id: 2,
      type: "fact",
      canonical_key: key,
      files_read: ["src/retrieval/hybrid.ts"],
      files_modified: [],
      embedding: null,
    },
  );

  if (staleScore >= 0.22) {
    failures.push({ caseId: "decay", message: `Expected old low-value memory to decay below stale threshold, got ${staleScore}` });
  }
  if (reinforced.state !== "active" || reinforced.usage_count !== 1) {
    failures.push({ caseId: "feedback", message: "Used stale memory was not reinforced/reactivated" });
  }
  if (!duplicate) {
    failures.push({ caseId: "dedupe", message: "Canonical duplicate was not detected" });
  }

  return {
    suite: "lifecycle",
    passed: failures.length === 0,
    metrics: {
      staleScore: round(staleScore),
      reinforcedImportance: round(reinforced.importance),
      duplicateDetected: duplicate ? 1 : 0,
    },
    failures,
  };
}

async function seedCorpus(
  store: Store,
  corpus: EvalCorpusCase[],
  embeddings: EmbeddingsProvider,
): Promise<Map<number, string>> {
  const idByMemoryId = new Map<number, string>();
  store.upsertSession("eval-session", "eval", "eval-repo", "/eval");

  for (const item of corpus) {
    for (const fixture of item.expectedMemories) {
      const queryText = item.queries.map((query) => query.query).join("\n");
      const keywordText = fixture.keywords?.join(" ") ?? "";
      const content = `${fixture.title}\n${fixture.description}\n${keywordText}\n${queryText}`;
      const memory = store.insertMemory({
        session_id: "eval-session",
        repo_id: "eval-repo",
        workspace_root: "/eval",
        type: fixture.type,
        title: fixture.title,
        description: `${fixture.description}\n\nEval keywords: ${keywordText}\nEval queries: ${queryText}`,
        files_read: fixture.filesRead ?? [],
        files_modified: fixture.filesModified ?? [],
        source_observation_ids: [],
        source_trace_ids: [],
        created_at: Date.now(),
        embedding: await embeddings.embed(content),
      });
      idByMemoryId.set(memory.id, fixture.id);
    }
  }

  return idByMemoryId;
}

function combineReports(reports: EvalReport[]): EvalReport {
  const failures = reports.flatMap((report) => report.failures);
  const metrics: Record<string, number> = {};

  for (const report of reports) {
    for (const [key, value] of Object.entries(report.metrics)) {
      metrics[`${report.suite}.${key}`] = value;
    }
  }

  return {
    suite: "all",
    passed: reports.every((report) => report.passed),
    metrics,
    failures,
  };
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
