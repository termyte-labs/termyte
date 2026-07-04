import type { Memory } from "../core/types.js";

export interface RetrievalScoreBreakdown {
  fts_rrf: number;
  vector_rrf: number;
  base_score: number;
  confidence_adjustment: number;
  importance_adjustment: number;
  decay_adjustment: number;
  usage_adjustment: number;
  feedback_adjustment: number;
  multiplier: number;
  final_score: number;
}

export function scoreMemoryCandidate(input: {
  memory: Memory;
  ftsRank?: number;
  vectorRank?: number;
  feedbackScore?: number;
  rrfK?: number;
}): RetrievalScoreBreakdown {
  const k = input.rrfK ?? 60;
  const fts = input.ftsRank ? 1 / (k + input.ftsRank) : 0;
  const vector = input.vectorRank ? 1 / (k + input.vectorRank) : 0;
  const base = fts + vector;
  const confidence = (clamp01(input.memory.confidence ?? 0.5) - 0.5) * 0.10;
  const importance = (clamp01(input.memory.importance ?? 0.5) - 0.5) * 0.10;
  const decay = (clamp01(input.memory.decayed_score ?? 0.5) - 0.5) * 0.10;
  const usage = Math.min(1, Math.log1p(Math.max(0, input.memory.usage_count ?? 0)) / Math.log(11)) * 0.05;
  const feedback = clamp(input.feedbackScore ?? 0, -1, 1) * 0.10;
  const multiplier = clamp(1 + confidence + importance + decay + usage + feedback, 0.75, 1.25);
  return {
    fts_rrf: fts,
    vector_rrf: vector,
    base_score: base,
    confidence_adjustment: confidence,
    importance_adjustment: importance,
    decay_adjustment: decay,
    usage_adjustment: usage,
    feedback_adjustment: feedback,
    multiplier,
    final_score: base * multiplier,
  };
}

function clamp01(value: number): number { return clamp(value, 0, 1); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

