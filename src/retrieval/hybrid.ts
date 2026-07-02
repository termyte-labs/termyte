import type { Memory } from "../core/types.js";
import type { EmbeddingsProvider } from "./embeddings.js";
import { FTSSearch, type FTSSearchOptions } from "./fts.js";
import { VectorSearch, type VectorSearchOptions, type VectorSearchResult } from "./vector.js";

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
}

/**
 * Hybrid search: FTS5 keyword + cosine-similarity vector.
 * Combined via Reciprocal Rank Fusion (k=60).
 * File-aware boosting applied in the vector branch.
 */
export class HybridSearch {
  private fts: FTSSearch;
  private vector: VectorSearch;
  private embeddings: EmbeddingsProvider;

  constructor(opts: { fts: FTSSearch; vector: VectorSearch; embeddings: EmbeddingsProvider }) {
    this.fts = opts.fts;
    this.vector = opts.vector;
    this.embeddings = opts.embeddings;
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
    const k = 60;
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

    const out: HybridSearchResult[] = [];
    for (const [id, ranks] of seen) {
      let combined = 0;
      if (ranks.fts_rank) combined += 1 / (k + ranks.fts_rank);
      if (ranks.vector_rank) combined += 1 / (k + ranks.vector_rank);
      const memory = byId.get(id);
      if (!memory) continue;
      out.push({ memory, fts_rank: ranks.fts_rank, vector_rank: ranks.vector_rank, combined_score: combined });
    }

    out.sort((a, b) => b.combined_score - a.combined_score);
    return out.slice(0, limit);
  }
}
