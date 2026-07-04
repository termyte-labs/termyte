import type { MemoryFeedbackEvent, MemoryState } from "../core/types.js";
import { clamp01 } from "./decay.js";

export interface FeedbackState {
  state: MemoryState;
  importance: number;
  confidence: number;
  usage_count: number;
  last_accessed_at?: number | null;
  last_reinforced_at?: number | null;
}

export interface FeedbackResult extends FeedbackState {
  weight: number;
}

export function feedbackDelta(eventType: MemoryFeedbackEvent): {
  importanceDelta: number;
  confidenceDelta: number;
  usageDelta: number;
} {
  switch (eventType) {
    case "shown":
      // Exposure is attribution evidence, not usefulness evidence. Boosting on
      // `shown` creates a self-reinforcing ranking loop.
      return { importanceDelta: 0, confidenceDelta: 0, usageDelta: 0 };
    case "used":
      return { importanceDelta: 0.06, confidenceDelta: 0.02, usageDelta: 1 };
    case "ignored":
      return { importanceDelta: -0.02, confidenceDelta: 0, usageDelta: 0 };
    case "downranked":
      return { importanceDelta: -0.05, confidenceDelta: 0, usageDelta: 0 };
    case "corrected":
      return { importanceDelta: 0, confidenceDelta: -0.10, usageDelta: 0 };
  }
}

export function defaultFeedbackWeight(eventType: MemoryFeedbackEvent): number {
  switch (eventType) {
    case "shown":
      return 0.03;
    case "used":
      return 0.25;
    case "ignored":
      return -0.04;
    case "downranked":
      return -0.08;
    case "corrected":
      return -0.10;
  }
}

export function applyFeedback(
  current: FeedbackState,
  eventType: MemoryFeedbackEvent,
  nowMs: number,
): FeedbackResult {
  const delta = feedbackDelta(eventType);
  const nextConfidence = clamp01(current.confidence + delta.confidenceDelta);
  let nextState = current.state;

  if (eventType === "used" && current.state === "stale") {
    nextState = "active";
  }

  if (eventType === "corrected" && nextConfidence < 0.3) {
    nextState = "conflicted";
  }

  return {
    state: nextState,
    importance: clamp01(current.importance + delta.importanceDelta),
    confidence: nextConfidence,
    usage_count: Math.max(0, current.usage_count + delta.usageDelta),
    last_accessed_at: eventType === "used" ? nowMs : current.last_accessed_at ?? null,
    last_reinforced_at: eventType === "used" ? nowMs : current.last_reinforced_at ?? null,
    weight: defaultFeedbackWeight(eventType),
  };
}
