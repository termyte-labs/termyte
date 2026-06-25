import type { Memory } from "../core/types.js";
import type { EmbeddingsProvider } from "./embeddings.js";
import { FTSSearch, type FTSSearchOptions } from "./fts.js";
import { VectorSearch, type VectorSearchOptions, type VectorSearchResult } from "./vector.js";

export interface HybridSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  type?: string;
  recencyWindowMs?: number;
  /** Optional recency filter (ms). Default 90 days, matching claude-mem. */
  defaultRecencyWindowMs?: number;
}

export interface HybridSearchResult {
  memory: Memory;
  /** FTS rank, 1-based. Absent if not in the FTS result set. */
  fts_rank?: number;
  /** Vector rank, 1-based. Absent if not in the vector result set. */
  vector_rank?: number;
  /** Reciprocal-rank-fusion score. Higher is better. */
  combined_score: number;
}

/**
 * Hybrid search combining FTS5 keyword search and cosine-similarity vector
 * search.
 *
 * Combination: standard reciprocal rank fusion (RRF) with k=60. No
 * learned re-ranker, no confidence weighting, no decay. Just two rank
 * lists summed.
 *
 * If no embeddings provider is configured the vector branch silently
 * returns no results and the result is the FTS list only.
 */
export class HybridSearch {
  private fts: FTSSearch;
  private vector: VectorSearch;
  private embeddings: EmbeddingsProvider;

  constructor(opts: {
    fts: FTSSearch;
    vector: VectorSearch;
    embeddings: EmbeddingsProvider;
  }) {
    this.fts = opts.fts;
    this.vector = opts.vector;
    this.embeddings = opts.embeddings;
  }

  async search(options: HybridSearchOptions): Promise<HybridSearchResult[]> {
    const limit = options.limit ?? 20;
    const recency = options.recencyWindowMs ?? options.defaultRecencyWindowMs ?? 90 * 24 * 60 * 60 * 1000;

    // FTS path.
    const ftsOptions: FTSSearchOptions = {
      query: options.query,
      project: options.project,
      type: options.type,
      limit: limit * 2,
    };
    const ftsResults = this.fts.search(ftsOptions);

    // Vector path. If embeddings throw, return FTS-only results.
    let vectorResults: VectorSearchResult[] = [];
    try {
      const queryVec = await this.embeddings.embed(options.query);
      const vectorOptions: VectorSearchOptions = {
        query: queryVec,
        project: options.project,
        type: options.type,
        limit: limit * 2,
        recencyWindowMs: recency,
      };
      vectorResults = this.vector.search(vectorOptions);
    } catch {
      // No embeddings or failure: skip the vector branch.
    }

    // RRF combination.
    const k = 60;
    const seen = new Map<number, { fts_rank?: number; vector_rank?: number }>();
    ftsResults.forEach((m, i) => {
      seen.set(m.id, { fts_rank: i + 1 });
    });
    vectorResults.forEach((r, i) => {
      const prev = seen.get(r.memory.id);
      if (prev) {
        prev.vector_rank = i + 1;
      } else {
        seen.set(r.memory.id, { vector_rank: i + 1 });
      }
    });

    const byId = new Map<number, Memory>();
    for (const m of ftsResults) byId.set(m.id, m);
    for (const r of vectorResults) byId.set(r.memory.id, r.memory);

    const out: HybridSearchResult[] = [];
    for (const [id, ranks] of seen.entries()) {
      let combined = 0;
      if (ranks.fts_rank) combined += 1 / (k + ranks.fts_rank);
      if (ranks.vector_rank) combined += 1 / (k + ranks.vector_rank);
      const memory = byId.get(id);
      if (!memory) continue;
      out.push({
        memory,
        fts_rank: ranks.fts_rank,
        vector_rank: ranks.vector_rank,
        combined_score: combined,
      });
    }

    out.sort((a, b) => b.combined_score - a.combined_score);
    return out.slice(0, limit);
  }
}
