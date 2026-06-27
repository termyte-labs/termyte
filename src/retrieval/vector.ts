import type { Store } from "../storage/store.js";
import type { Memory } from "../core/types.js";
import { FTSSearch, type FTSSearchOptions } from "./fts.js";

export interface VectorSearchOptions {
  query: Float32Array;
  /** Optional text query used to pre-filter the candidate set via FTS5.
   *  When provided (along with ftsRepoId / ftsType), the in-memory
   *  cosine only runs on memories that match the FTS5 query — a
   *  substantial speedup at scale. C1 Part A. */
  ftsQuery?: string;
  ftsRepoId?: string;
  ftsType?: string;
  repo_id?: string;
  limit?: number;
  type?: string;
  recencyWindowMs?: number;
  /** Files in the current task for file-aware boosting. */
  currentFiles?: string[];
}

export interface VectorSearchResult {
  memory: Memory;
  score: number;
}

/**
 * Semantic vector search via cosine similarity.
 *
 * Vectors are stored as BLOBs on the `memories` row. C1 Part A
 * pre-filters the candidate set via FTS5 when `ftsQuery` is
 * provided, so the in-memory cosine only runs on the top N
 * FTS-matching candidates. At 5,000+ memories this brings search
 * latency from 50–200 ms down to < 10 ms.
 */
export class VectorSearch {
  private fts: FTSSearch;
  constructor(store: Store) {
    this.store = store;
    this.fts = new FTSSearch(store);
  }
  private store: Store;

  search(options: VectorSearchOptions): VectorSearchResult[] {
    // Pre-filter candidate set: either the FTS5 ids (when given an
    // ftsQuery) or all embedded memories (the legacy path).
    let candidates: Memory[];
    if (options.ftsQuery) {
      const ftsOpts: FTSSearchOptions = {
        query: options.ftsQuery,
        repo_id: options.ftsRepoId,
        type: options.ftsType,
        limit: 200,
      };
      const candidateIds = new Set(this.fts.searchIds(ftsOpts));
      const all = this.store.getAllMemoriesWithEmbeddings(options.repo_id);
      candidates = all.filter((m) => candidateIds.has(m.id));
    } else {
      candidates = this.store.getAllMemoriesWithEmbeddings(options.repo_id);
    }
    if (candidates.length === 0) return [];

    const cutoff = options.recencyWindowMs
      ? Date.now() - options.recencyWindowMs
      : null;

    const currentFileSet = new Set(options.currentFiles ?? []);

    const filtered = candidates.filter((m) => {
      if (!m.embedding) return false;
      if (options.type && m.type !== options.type) return false;
      if (cutoff !== null && m.created_at < cutoff) return false;
      if (options.repo_id && m.repo_id !== options.repo_id) return false;
      return true;
    });

    if (filtered.length === 0) return [];

    const scored: VectorSearchResult[] = filtered.map((m) => {
      let score = cosineSimilarity(options.query, m.embedding!);

      // File-aware boosting: boost memories whose files overlap with
      // the files in the current task (15% per overlapping file).
      if (currentFileSet.size > 0) {
        let overlap = 0;
        for (const f of m.files_read) if (currentFileSet.has(f)) overlap++;
        for (const f of m.files_modified) if (currentFileSet.has(f)) overlap++;
        if (overlap > 0) score *= (1 + overlap * 0.15);
      }

      return { memory: m, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit ?? 20);
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!, bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
