import type { Store } from "../storage/store.js";
import type { Memory } from "../core/types.js";

export interface VectorSearchOptions {
  query: Float32Array;
  project?: string;
  limit?: number;
  type?: string;
  recencyWindowMs?: number;
}

export interface VectorSearchResult {
  memory: Memory;
  score: number;
}

/**
 * Semantic vector search via cosine similarity.
 *
 * Vectors are stored on the `memories` row and loaded in full on each
 * query. For larger corpora a real vector index is required; this is
 * out of scope per the spec.
 */
export class VectorSearch {
  constructor(private store: Store) {}

  search(options: VectorSearchOptions): VectorSearchResult[] {
    const all = this.store.getAllMemoriesWithEmbeddings(options.project);
    if (all.length === 0) return [];

    const cutoff = options.recencyWindowMs
      ? Date.now() - options.recencyWindowMs
      : null;

    const filtered = all.filter((m) => {
      if (!m.embedding) return false;
      if (options.type && m.type !== options.type) return false;
      if (cutoff !== null && m.created_at < cutoff) return false;
      return true;
    });

    if (filtered.length === 0) return [];

    const scored: VectorSearchResult[] = filtered.map((m) => ({
      memory: m,
      score: cosineSimilarity(options.query, m.embedding!),
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit ?? 20);
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
