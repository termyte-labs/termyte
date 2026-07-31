import { Store } from "../storage/store.js";
import { openDatabase } from "../storage/connection.js";
import { JobQueue } from "../context/pipeline/job-queue.js";
import { MemoryPipeline } from "../context/pipeline/memory-pipeline.js";
import { RetryableJobError } from "../context/pipeline/errors.js";
import { FTSSearch } from "../context/retrieval/fts.js";
import { VectorSearch } from "../context/retrieval/vector.js";
import { HybridSearch } from "../context/retrieval/hybrid.js";
import type { EmbeddingsProvider } from "../context/retrieval/embeddings.js";
import { memoryDecayScore } from "../context/lifecycle/decay.js";
import { applyFeedback } from "../context/lifecycle/feedback.js";
import { canonicalMemoryKey, shouldDeduplicate } from "../context/lifecycle/dedupe.js";
import { buildMemoryExplain } from "../context/explain/memory-explain.js";
import { loadRegressionCorpus, type EvalCorpusCase } from "./corpus.js";
import { mean, mrr, precisionAtK, recallAtK, type RankedResultLike } from "./metrics.js";
import { assertDurabilityInvariants, FaultInjector } from "./fault-injection.js";
import { ContextBuilder } from "../context/builder.js";

export type EvalSuiteName = "all" | "retrieval" | "durability" | "lifecycle" | "correction" | "closed-loop";

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
      await runCorrectionEval(),
      await runClosedLoopEval(),
    ]);
  }

  if (suite === "retrieval") return runRetrievalEval(options);
  if (suite === "durability") return runDurabilityEval();
  if (suite === "lifecycle") return runLifecycleEval();
  if (suite === "correction") return runCorrectionEval();
  if (suite === "closed-loop") return runClosedLoopEval();

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
    feedbackStore: store,
  });

  const recallValues: number[] = [];
  const precisionValues: number[] = [];
  const mrrValues: number[] = [];
  const failures: EvalFailure[] = [];

  try {
    for (const item of corpus) {
      for (const query of item.queries) {
        const results = await search.search({
          query: query.query,
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
              actualResults: results.map((result) => ({
                id: idByMemoryId.get(result.memory.id) ?? `memory:${result.memory.id}`,
                ftsRank: result.fts_rank ?? null,
                vectorRank: result.vector_rank ?? null,
                score: round(result.combined_score),
              })),
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

  // The checked-in corpus contains no answer-key text. Recall is the release
  // gate; MRR, precision, and per-query misses remain diagnostic evidence.
  const allFailures = [...failures];
  if (metrics.recallAt5 < 0.9) {
    allFailures.push({
      caseId: "retrieval_threshold",
      message: `Recall@5 ${metrics.recallAt5.toFixed(3)} is below the required 0.900`,
    });
  }
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
  }, "helpful", nowMs);

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
  if (reinforced.state !== "active" || reinforced.importance <= 0.5) {
    failures.push({ caseId: "feedback", message: "Helpful stale memory was not reinforced/reactivated" });
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

export async function runCorrectionEval(): Promise<EvalReport> {
  const store = new Store(openDatabase(":memory:"));
  const embeddings = new FixedEmbeddingsProvider();
  const failures: EvalFailure[] = [];

  try {
    store.upsertSession("s1", "eval", "repo", "/w");
    const original = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/w",
      type: "fact",
      title: "Use old API",
      description: "The old API should be used.",
      files_read: ["src/api.ts"],
      files_modified: [],
      source_observation_ids: [1],
      source_trace_ids: [1],
      created_at: Date.now(),
      embedding: await embeddings.embed("Use old API\nThe old API should be used."),
    });
    store.updateMemoryEmbedding(original.id, await embeddings.embed("Use old API\nThe old API should be used."));
    const episode = store.startEpisode({ sessionId: "s1", repoId: "repo", workspaceRoot: "/w", task: "Correct old API" });
    const packet = store.recordContextPacket({
      sessionId: "s1", episodeId: episode.id, repoId: "repo", agent: "eval", task: "Correct old API",
      tokenBudget: 100, estimatedTokens: 1, retrievalMode: "fts", latencyMs: 1,
      renderedText: "context", candidates: [],
    });
    store.recordContextInjection({
      id: "eval-correction-injection", sessionId: "s1", repoId: "repo", memoryIds: [original.id],
      surface: "eval", packetId: packet.id,
    });
    store.recordMemoryFeedback({
      id: `memory:${original.id}`,
      event: "corrected",
      correctionText: "Use the new API instead of the old one.",
      contextInjectionId: "eval-correction-injection",
      source: "eval",
    });

    const pipeline = new MemoryPipeline({
      store,
      llm: {
        async chat(messages: Array<{ role: string; content: string }>) {
          const prompt = messages.map((message) => message.content).join("\n");
          if (prompt.includes("Generate a summary of this completed agent session.")) {
            return { content: "<skip_summary />", model: "eval" };
          }
          return { content: "<skip_summary />", model: "eval" };
        },
      },
      embeddings,
    });

    await pipeline.runUntilIdle("eval-worker", { maxJobs: 10 });

    const replacement = store.getRecentMemories(10).find((memory) => memory.id !== original.id && memory.title.startsWith("Corrected: "));
    if (!replacement) {
      failures.push({ caseId: "replacement", message: "Expected corrected replacement memory" });
    } else {
      if (replacement.lifecycle_state !== "active") {
        failures.push({ caseId: "replacement_state", message: `Replacement memory was ${replacement.lifecycle_state}` });
      }
      if (store.getMemory(original.id)?.lifecycle_state !== "superseded") {
        failures.push({ caseId: "original_state", message: "Original memory was not superseded" });
      }
      if (!store.getMemoryEdges(replacement.id).some((edge) => edge.edge_type === "supersedes" && edge.target_memory_id === original.id)) {
        failures.push({ caseId: "supersedes_edge", message: "Replacement memory did not record a supersedes edge" });
      }
      const explain = buildMemoryExplain(store, `memory:${original.id}`);
      if (!explain.feedback.some((row: { event_type: string }) => row.event_type === "corrected")) {
        failures.push({ caseId: "feedback", message: "Corrected feedback was not retained on the original memory" });
      }
    }

    const conflicted = store.insertMemory({
      session_id: "s1",
      repo_id: "repo",
      workspace_root: "/w",
      type: "warning",
      title: "Remove old API",
      description: "This should be corrected without replacement text.",
      files_read: ["src/api.ts"],
      files_modified: [],
      source_observation_ids: [2],
      source_trace_ids: [2],
      created_at: Date.now(),
      embedding: await embeddings.embed("Remove old API\nThis should be corrected without replacement text."),
    });
    store.recordMemoryFeedback({
      id: `memory:${conflicted.id}`,
      event: "corrected",
      source: "eval",
    });
    await pipeline.runUntilIdle("eval-worker", { maxJobs: 10 });

    const conflictedMemory = store.getMemory(conflicted.id);
    if (!conflictedMemory || conflictedMemory.lifecycle_state !== "conflicted") {
      failures.push({ caseId: "conflicted", message: "Expected conflicted memory without replacement text" });
    }

    const ftSearch = new FTSSearch(store);
    const results = ftSearch.search({ query: "old API", repo_id: "repo", limit: 10 });
    if (results.some((memory) => memory.id === conflicted.id)) {
      failures.push({ caseId: "conflicted_search", message: "Conflicted memory remained retrievable by default" });
    }

    return {
      suite: "correction",
      passed: failures.length === 0,
      metrics: {
        replacementCreated: replacement ? 1 : 0,
        originalSuperseded: store.getMemory(original.id)?.lifecycle_state === "superseded" ? 1 : 0,
        conflictedSuppressed: conflictedMemory?.lifecycle_state === "conflicted" ? 1 : 0,
      },
      failures,
    };
  } finally {
    store.close();
  }
}

export async function runClosedLoopEval(): Promise<EvalReport> {
  const store = new Store(openDatabase(":memory:"));
  const embeddings = new FixedEmbeddingsProvider();
  const failures: EvalFailure[] = [];
  try {
    store.upsertSession("closed-loop", "eval", "repo", "/w");
    const memory = store.insertMemory({
      session_id: "closed-loop", repo_id: "repo", workspace_root: "/w", type: "procedure",
      title: "Validate auth changes", description: "Run npm test after editing src/auth.ts.",
      files_read: ["src/auth.ts"], files_modified: [], source_observation_ids: [], source_trace_ids: [],
      created_at: 1, embedding: await embeddings.embed("Validate auth changes npm test src/auth.ts"),
    });
    const episodes = [
      store.startEpisode({ sessionId: "closed-loop", repoId: "repo", workspaceRoot: "/w", task: "Fix src/auth.ts" }),
      store.startEpisode({ sessionId: "closed-loop", repoId: "repo", workspaceRoot: "/w", task: "Retry src/auth.ts" }),
    ];
    const cases = [
      { suffix: "helped", episode: episodes[0]!, event: "helpful" as const, outcome: "succeeded" as const },
      { suffix: "hurt", episode: episodes[1]!, event: "harmful" as const, outcome: "failed" as const },
    ];
    for (const item of cases) {
      const packet = store.recordContextPacket({
        id: `eval-packet-${item.suffix}`, sessionId: "closed-loop", episodeId: item.episode.id,
        repoId: "repo", agent: "eval", task: item.episode.task, tokenBudget: 256, estimatedTokens: 20,
        retrievalMode: "eval", latencyMs: 1, renderedText: "memory context",
        candidates: [{
          candidateId: `memory:${memory.id}`, kind: "procedure", sourceId: String(memory.id),
          tokenEstimate: 20, selected: true, rank: 1, finalScore: 1, renderedText: "memory context",
        }],
      });
      const injectionId = `eval-injection-${item.suffix}`;
      store.recordContextInjection({
        id: injectionId, sessionId: "closed-loop", repoId: "repo", query: item.episode.task,
        memoryIds: [memory.id], items: [{ memoryId: memory.id, rank: 1, score: 1, renderedText: "memory context" }],
        surface: "eval", packetId: packet.id,
      });
      store.recordMemoryFeedback({ id: `memory:${memory.id}`, event: item.event, contextInjectionId: injectionId, source: "eval" });
      store.recordEpisodeOutcome({ episodeId: item.episode.id, status: item.outcome, source: "human", contextInjectionId: injectionId });
    }

    const pipeline = new MemoryPipeline({
      store, embeddings,
      llm: { async chat() { return { content: "<skip_summary />", model: "eval" }; } },
    });
    await pipeline.runUntilIdle("closed-loop-worker", { maxJobs: 20 });
    await pipeline.runUntilIdle("closed-loop-worker", { maxJobs: 20 });

    const counts = store.getRecentContextEffectCounts();
    const selectedCandidates = cases.length;
    const attributionRate = counts.total / selectedCandidates;
    if (counts.helped !== 1 || counts.hurt !== 1 || counts.total !== 2) {
      failures.push({ caseId: "effect_classification", message: `Expected one helped and one hurt effect, got ${JSON.stringify(counts)}` });
    }
    if (attributionRate !== 1) failures.push({ caseId: "attribution", message: `Expected complete attribution, got ${attributionRate}` });

    const search = new HybridSearch({
      fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings, feedbackStore: store,
    });
    const abstained = await new ContextBuilder(store, search).build({
      repo_id: "repo", query: "ZZZ_UNRELATED_ADVERSARIAL_TASK", surface: "eval", tokenBudget: 256,
    });
    if (abstained.contextInjectionId !== null || abstained.text !== "") {
      failures.push({ caseId: "abstention", message: "Unrelated task produced a context delivery" });
    }

    return {
      suite: "closed-loop",
      passed: failures.length === 0,
      metrics: {
        selectedCandidates,
        attributedEffects: counts.total,
        attributionRate: round(attributionRate),
        helpedEffects: counts.helped,
        hurtEffects: counts.hurt,
        unknownEffects: counts.unknown,
        retryDuplicates: Math.max(0, counts.total - selectedCandidates),
        abstentionCorrect: abstained.contextInjectionId === null ? 1 : 0,
      },
      failures,
    };
  } finally {
    store.close();
  }
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
      const content = `${fixture.title}\n${fixture.description}`;
      const memory = store.insertMemory({
        session_id: "eval-session",
        repo_id: "eval-repo",
        workspace_root: "/eval",
        type: fixture.type,
        title: fixture.title,
        description: fixture.description,
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
