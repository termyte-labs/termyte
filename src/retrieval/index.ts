import type Database from "better-sqlite3";
import type { Memory, MemoryWithScore, SearchResult, RankingWeights } from "../types.js";
import { DEFAULT_RANKING_WEIGHTS } from "../types.js";
import type { GeminiClient } from "../extraction/gemini.js";
import { keywordSearch } from "./fts.js";
import { vectorSearch, storeEmbedding } from "./vector.js";
import { rankMemories } from "./ranking.js";
import { buildInjectionContext, formatForAgent, type InjectedContext } from "./inject.js";

export interface RetrievalEngine {
  search(query: string, options?: SearchOptions): Promise<SearchResult>;
  inject(task: string, options?: SearchOptions): Promise<InjectedContext>;
  indexMemory(memoryId: string, text: string): Promise<void>;
  reindexAll(): Promise<void>;
}

export interface SearchOptions {
  scope?: string;
  type?: string;
  limit?: number;
  weights?: RankingWeights;
}

export function createRetrievalEngine(
  db: Database.Database,
  gemini: GeminiClient,
): RetrievalEngine {
  async function search(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const startTime = Date.now();
    const limit = options.limit ?? 10;
    const weights = options.weights ?? DEFAULT_RANKING_WEIGHTS;

    const keywordResults = keywordSearch(db, query, limit * 2);

    let vectorResults: Array<{ memory: Memory; score: number }> = [];
    try {
      const queryEmbedding = await gemini.embedText(query);
      vectorResults = vectorSearch(db, queryEmbedding, limit * 2);
    } catch {
      // Vector search is optional; fall back to keyword-only
    }

    let allResults = rankMemories(keywordResults, vectorResults, weights, limit);

    if (options.scope) {
      allResults = allResults.filter((r) => r.repoScope === options.scope);
    }
    if (options.type) {
      allResults = allResults.filter((r) => r.type === options.type);
    }

    return {
      memories: allResults.slice(0, limit),
      queryTime: Date.now() - startTime,
      totalCount: allResults.length,
    };
  }

  async function inject(task: string, options: SearchOptions = {}): Promise<InjectedContext> {
    const result = await search(task, { ...options, limit: options.limit ?? 5 });
    return buildInjectionContext(result.memories, task);
  }

  async function indexMemory(memoryId: string, text: string): Promise<void> {
    try {
      const embedding = await gemini.embedText(text);
      storeEmbedding(db, memoryId, embedding);
    } catch {
      // Indexing is best-effort
    }
  }

  async function reindexAll(): Promise<void> {
    const rows = db.prepare("SELECT id, claim FROM memories WHERE is_active = 1").all() as Array<{
      id: string;
      claim: string;
    }>;
    for (const row of rows) {
      await indexMemory(row.id, row.claim);
    }
  }

  return { search, inject, indexMemory, reindexAll };
}
