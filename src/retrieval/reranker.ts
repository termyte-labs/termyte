/**
 * Cross-encoder reranker using Xenova/ms-marco-MiniLM-L-6-v2.
 * Adapted from agentmemory's src/state/reranker.ts.
 *
 * Lazily loads the model via @huggingface/transformers (already a Termyte dependency).
 * Gated by TERMYTE_RERANKER_ENABLED=true env var (default off).
 */

import type { HybridSearchResult } from "./hybrid.js";

export class CrossEncoderReranker {
  private pipeline: any = null;
  private unavailable = false;
  private initPromise: Promise<void> | null = null;

  isEnabled(): boolean {
    return process.env.TERMYTE_RERANKER_ENABLED === "true";
  }

  async init(): Promise<void> {
    if (this.unavailable || this.pipeline) return;
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    await this.initPromise;
  }

  private async doInit(): Promise<void> {
    try {
      const { pipeline } = await import("@huggingface/transformers");
      this.pipeline = await pipeline("text-classification", "Xenova/ms-marco-MiniLM-L-6-v2", { dtype: "q8" });
    } catch {
      this.unavailable = true;
    }
  }

  async rerank(
    query: string,
    candidates: HybridSearchResult[],
    topK = 20,
  ): Promise<HybridSearchResult[]> {
    if (!this.isEnabled() || this.unavailable) return candidates;

    await this.init();
    if (!this.pipeline) return candidates;

    const toRerank = candidates.slice(0, topK);
    const inputs = toRerank.map((c) => {
      const text = `${c.memory.title} ${c.memory.description ?? ""}`.slice(0, 512);
      return { text: query, text_pair: text };
    });

    try {
      const outputs = await this.pipeline(inputs);
      const scored = toRerank.map((c, i) => {
        const score = typeof outputs[i]?.score === "number" ? outputs[i].score : c.combined_score;
        return { ...c, combined_score: score };
      });
      scored.sort((a, b) => b.combined_score - a.combined_score);

      // Merge reranked top-K back with the rest (unchanged).
      const rest = candidates.slice(topK);
      return [...scored, ...rest];
    } catch {
      return candidates;
    }
  }
}
