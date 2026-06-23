import type { Memory } from "../types.js";

export function computeConfidence(successCount: number, failureCount: number): number {
  return (successCount + 1) / (successCount + failureCount + 2);
}

export function updateConfidenceOnSuccess(memory: Memory): number {
  return computeConfidence(memory.successCount + 1, memory.failureCount);
}

export function updateConfidenceOnFailure(memory: Memory): number {
  return computeConfidence(memory.successCount, memory.failureCount + 1);
}

export function updateConfidenceOnOutcome(memory: Memory, outcome: "success" | "failure"): number {
  if (outcome === "success") {
    return updateConfidenceOnSuccess(memory);
  }
  return updateConfidenceOnFailure(memory);
}
