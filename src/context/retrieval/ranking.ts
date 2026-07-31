import type { Memory } from "../../shared/types.js";

export interface RetrievalScoreBreakdown {
  fts_rrf: number;
  vector_rrf: number;
  base_score: number;
  confidence_adjustment: number;
  importance_adjustment: number;
  decay_adjustment: number;
  usage_adjustment: number;
  feedback_adjustment: number;
  applicability_adjustment: number;
  multiplier: number;
  final_score: number;
}

export function scoreMemoryCandidate(input: {
  memory: Memory;
  ftsRank?: number;
  vectorRank?: number;
  feedbackScore?: number;
  query?: string;
  currentFiles?: string[];
  rrfK?: number;
}): RetrievalScoreBreakdown {
  const k = input.rrfK ?? 5;
  // Sparse matches carry exact technical evidence. Weight them above the
  // semantic branch so a noisy embedding list cannot bury an FTS rank-1 hit.
  const fts = input.ftsRank ? 2 / (k + input.ftsRank) : 0;
  const vector = input.vectorRank ? 1 / (k + input.vectorRank) : 0;
  const base = fts + vector;
  const confidence = (clamp01(input.memory.confidence ?? 0.5) - 0.5) * 0.10;
  const importance = (clamp01(input.memory.importance ?? 0.5) - 0.5) * 0.10;
  const decay = (clamp01(input.memory.decayed_score ?? 0.5) - 0.5) * 0.10;
  const usage = Math.min(1, Math.log1p(Math.max(0, input.memory.usage_count ?? 0)) / Math.log(11)) * 0.05;
  // One explicit helpful event has persisted weight 0.25; normalize it to a
  // full positive ranking signal while keeping all feedback bounded.
  const feedback = clamp((input.feedbackScore ?? 0) * 4, -1, 1) * 0.20;
  const applicability = computeApplicabilityAdjustment(input.memory, input.query, input.currentFiles);
  const multiplier = clamp(1 + confidence + importance + decay + usage + feedback + applicability, 0.75, 1.25);
  return {
    fts_rrf: fts,
    vector_rrf: vector,
    base_score: base,
    confidence_adjustment: confidence,
    importance_adjustment: importance,
    decay_adjustment: decay,
    usage_adjustment: usage,
    feedback_adjustment: feedback,
    applicability_adjustment: applicability,
    multiplier,
    final_score: base * multiplier,
  };
}

function clamp01(value: number): number { return clamp(value, 0, 1); }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }

function computeApplicabilityAdjustment(memory: Memory, query?: string, currentFiles?: string[]): number {
  const evidence = memory.applicability_evidence;
  if (!evidence) return 0;

  let score = 0;
  const normalizedQuery = normalizeText(query ?? "");
  const normalizedFiles = new Set((currentFiles ?? []).map(normalizeText).filter(Boolean));

  if (normalizedQuery.length > 0) {
    for (const command of evidence.commands) {
      const normalizedCommand = normalizeText(command);
      if (normalizedCommand && normalizedQuery.includes(normalizedCommand)) {
        score += 0.10;
        break;
      }
    }
  }

  if (normalizedFiles.size > 0) {
    let overlap = 0;
    for (const file of evidence.files) {
      if (normalizedFiles.has(normalizeText(file))) overlap++;
    }
    score += Math.min(0.10, overlap * 0.05);
  }

  return clamp(score, 0, 0.15);
}

function normalizeText(value: string): string {
  return value.replaceAll("\\", "/").trim().toLowerCase();
}
