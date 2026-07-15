import type { Memory } from "../core/types.js";
import type { EmbeddingsProvider } from "./embeddings.js";
import { FTSSearch, type FTSSearchOptions } from "./fts.js";
import { VectorSearch, type VectorSearchOptions, type VectorSearchResult } from "./vector.js";
import { scoreMemoryCandidate, type RetrievalScoreBreakdown } from "./ranking.js";
import { CrossEncoderReranker } from "./reranker.js";

export interface HybridSearchOptions {
  query: string;
  repo_id?: string;
  limit?: number;
  type?: string;
  recencyWindowMs?: number;
  /** Files in the current task context for file-aware boosting. */
  currentFiles?: string[];
  /** Override the default lifecycle eligibility policy. */
  eligibleStates?: readonly string[];
}

export interface HybridSearchResult {
  memory: Memory;
  fts_rank?: number;
  vector_rank?: number;
  combined_score: number;
  score_breakdown: RetrievalScoreBreakdown;
  graph_rank?: number;
}

/**
 * Hybrid search: FTS5 keyword + cosine-similarity vector.
 * Combined via Reciprocal Rank Fusion over short candidate lists.
 * File-aware boosting applied in the vector branch.
 */
export class HybridSearch {
  private fts: FTSSearch;
  private vector: VectorSearch;
  private embeddings: EmbeddingsProvider;
  private feedbackStore?: { getMemoryFeedbackScores(memoryIds: number[]): Map<number, number> };
  private reranker?: CrossEncoderReranker;

  constructor(opts: {
    fts: FTSSearch;
    vector: VectorSearch;
    embeddings: EmbeddingsProvider;
    feedbackStore?: { getMemoryFeedbackScores(memoryIds: number[]): Map<number, number> };
    reranker?: CrossEncoderReranker;
  }) {
    this.fts = opts.fts;
    this.vector = opts.vector;
    this.embeddings = opts.embeddings;
    this.feedbackStore = opts.feedbackStore;
    this.reranker = opts.reranker;
  }

  async search(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 20;

    const ftsResults = this.fts.search({
      query: options.query,
      repo_id: options.repo_id,
      type: options.type,
      limit: limit * 2,
      eligibleStates: options.eligibleStates,
    });

    let vectorResults: VectorSearchResult[] = [];
    try {
      const queryVec = await this.embeddings.embed(options.query);
      vectorResults = this.vector.search({
        query: queryVec,
        repo_id: options.repo_id,
        type: options.type,
        limit: limit * 2,
        recencyWindowMs: options.recencyWindowMs,
        currentFiles: options.currentFiles,
        eligibleStates: options.eligibleStates,
      });
    } catch {
      // No embeddings available: FTS-only.
    }

    // RRF combination.
    const k = 5;
    const seen = new Map<number, { fts_rank?: number; vector_rank?: number }>();
    ftsResults.forEach((m, i) => seen.set(m.id, { fts_rank: i + 1 }));
    vectorResults.forEach((r, i) => {
      const prev = seen.get(r.memory.id);
      if (prev) prev.vector_rank = i + 1;
      else seen.set(r.memory.id, { vector_rank: i + 1 });
    });

    const byId = new Map<number, Memory>();
    for (const m of ftsResults) byId.set(m.id, m);
    for (const r of vectorResults) byId.set(r.memory.id, r.memory);

    const feedbackScores = this.feedbackStore
      ? this.feedbackStore.getMemoryFeedbackScores([...seen.keys()])
      : new Map<number, number>();
    const out: HybridSearchResult[] = [];
    for (const [id, ranks] of seen) {
      const memory = byId.get(id);
      if (!memory) continue;
      const breakdown = scoreMemoryCandidate({
        memory,
        ftsRank: ranks.fts_rank,
        vectorRank: ranks.vector_rank,
        feedbackScore: feedbackScores.get(id),
        query: options.query,
        currentFiles: options.currentFiles,
        rrfK: k,
      });
      out.push({
        memory,
        fts_rank: ranks.fts_rank,
        vector_rank: ranks.vector_rank,
        combined_score: breakdown.final_score,
        score_breakdown: breakdown,
      });
    }

    out.sort((a, b) => b.combined_score - a.combined_score);

    // Cross-encoder reranking (optional, env-gated).
    if (this.reranker && this.reranker.isEnabled()) {
      const reranked = await this.reranker.rerank(options.query, out, Math.max(limit * 2, 20));
      return reranked.slice(0, limit);
    }

    // Session diversification: max 3 results per session.
    const diversified = diversifyBySession(out, limit, 3);
    return diversified;
  }
}

function diversifyBySession(
  results: HybridSearchResult[],
  limit: number,
  maxPerSession: number,
): HybridSearchResult[] {
  const sessionCounts = new Map<string, number>();
  const out: HybridSearchResult[] = [];
  for (const r of results) {
    const sid = r.memory.session_id;
    const count = sessionCounts.get(sid) ?? 0;
    if (count < maxPerSession) {
      out.push(r);
      sessionCounts.set(sid, count + 1);
      if (out.length >= limit) break;
    }
  }
  // If diversification didn't fill the limit, append remaining results.
  if (out.length < limit) {
    const seen = new Set(out.map((r) => r.memory.id));
    for (const r of results) {
      if (!seen.has(r.memory.id)) {
        out.push(r);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
