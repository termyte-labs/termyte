import type { Memory, MemoryWithScore, RankingWeights } from "../types.js";
import { clamp } from "../utils.js";

export function rankMemories(
  keywordResults: Array<{ memory: Memory; score: number }>,
  vectorResults: Array<{ memory: Memory; score: number }>,
  weights: RankingWeights,
  limit: number = 10,
): MemoryWithScore[] {
  const scores = new Map<string, { memory: Memory; keyword: number; semantic: number }>();

  for (const r of keywordResults) {
    const existing = scores.get(r.memory.id) ?? { memory: r.memory, keyword: 0, semantic: 0 };
    existing.keyword = Math.max(existing.keyword, r.score);
    scores.set(r.memory.id, existing);
  }

  for (const r of vectorResults) {
    const existing = scores.get(r.memory.id) ?? { memory: r.memory, keyword: 0, semantic: 0 };
    existing.semantic = Math.max(existing.semantic, r.score);
    scores.set(r.memory.id, existing);
  }

  const maxKeyword = Math.max(...Array.from(scores.values()).map((s) => s.keyword), 0.001);
  const maxSemantic = Math.max(...Array.from(scores.values()).map((s) => s.semantic), 0.001);

  const results: MemoryWithScore[] = [];

  for (const [, { memory, keyword, semantic }] of scores) {
    const normalizedKeyword = keyword / maxKeyword;
    const normalizedSemantic = semantic / maxSemantic;
    const confidenceFactor = memory.confidence;

    const combinedScore =
      weights.semantic * normalizedSemantic +
      weights.keyword * normalizedKeyword +
      weights.confidence * confidenceFactor;

    const matchedBecause = normalizedKeyword > normalizedSemantic
      ? `keyword match (score: ${normalizedKeyword.toFixed(2)})`
      : `semantic similarity (score: ${normalizedSemantic.toFixed(2)})`;

    results.push({
      ...memory,
      score: clamp(combinedScore, 0, 1),
      keywordScore: normalizedKeyword,
      semanticScore: normalizedSemantic,
      matchedBecause,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
