import type { Store } from "../storage/store.js";
import type { Memory } from "../core/types.js";
import { isMemoryEligible, eligibleMemoryStates } from "./eligibility.js";

export interface VectorSearchOptions {
  query: Float32Array;
  repo_id?: string;
  limit?: number;
  type?: string;
  recencyWindowMs?: number;
  /** Files in the current task for file-aware boosting. */
  currentFiles?: string[];
  /** Override the default lifecycle eligibility policy. */
  eligibleStates?: readonly string[];
}

export interface VectorSearchResult {
  memory: Memory;
  score: number;
}

/**
 * Semantic vector search via cosine similarity.
 *
 * Vectors are stored as BLOBs on the `memories` row. Loaded in full
 * on each query; adequate for MVP-scale corpora.
 */
export class VectorSearch {
  constructor(private store: Store) {}

  search(options: VectorSearchOptions): VectorSearchResult[] {
    const indexed = this.store.searchMemoryVectorIndex(options.query, Math.max((options.limit ?? 20) * 20, 100));
    const all = indexed === null
      ? this.store.getAllMemoriesWithEmbeddings(options.repo_id)
      : indexed.map((hit) => this.store.getMemory(hit.memoryId)).filter((memory): memory is Memory => memory !== null);
    if (all.length === 0) return [];

    const cutoff = options.recencyWindowMs
      ? Date.now() - options.recencyWindowMs
      : null;

    const currentFileSet = new Set(options.currentFiles ?? []);
    const states = eligibleMemoryStates(options.eligibleStates);

    const filtered = all.filter((m) => {
      if (!m.embedding) return false;
      if (options.type && m.type !== options.type) return false;
      if (cutoff !== null && m.created_at < cutoff) return false;
      if (options.repo_id && m.repo_id !== options.repo_id) return false;
      if (!isMemoryEligible(m, states)) return false;
      return true;
    });

    if (filtered.length === 0) return [];

    const indexedScores = indexed === null ? null : new Map(indexed.map((hit) => [hit.memoryId, hit.score]));
    const scored: VectorSearchResult[] = filtered.map((m) => {
      let score = indexedScores?.get(m.id) ?? cosineSimilarity(options.query, m.embedding!);

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
