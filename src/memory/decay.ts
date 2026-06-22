import type Database from "better-sqlite3";
import type { Memory } from "../types.js";
import { daysSince, clamp } from "../utils.js";

export interface DecayResult {
  memoryId: string;
  oldConfidence: number;
  newConfidence: number;
  reason: string;
}

export function computeDecayScore(memory: Memory): number {
  const ageFactor = Math.exp(-(daysSince(memory.lastVerified ?? memory.updatedAt)) / 60);
  const usageFactor = memory.lastVerified && daysSince(memory.lastVerified) < 30 ? 1.0 : 0.5;
  return clamp(ageFactor * usageFactor, 0, 1);
}

export function applyDecay(db: Database.Database, options: { threshold?: number; dryRun?: boolean } = {}): DecayResult[] {
  const threshold = options.threshold ?? 0.3;
  const results: DecayResult[] = [];

  const memories = db.prepare("SELECT * FROM memories WHERE is_active = 1").all() as Array<{
    id: string;
    confidence: number;
    success_count: number;
    failure_count: number;
    last_verified: string | null;
    updated_at: string;
  }>;

  for (const mem of memories) {
    const oldConfidence = mem.confidence;
    const ageDays = daysSince(mem.last_verified ?? mem.updated_at);
    const ageFactor = Math.exp(-ageDays / 60);
    const reliabilityFactor = (mem.success_count + 1) / (mem.success_count + mem.failure_count + 2);
    const newConfidence = clamp(oldConfidence * ageFactor * 0.5 + reliabilityFactor * 0.5, 0.05, 0.99);

    if (Math.abs(newConfidence - oldConfidence) > 0.01) {
      let reason = "";
      if (ageDays > 60) reason = `Stale: last verified ${Math.floor(ageDays)} days ago`;
      else if (mem.failure_count > mem.success_count) reason = "High failure rate";
      else reason = "Confidence adjustment based on age and reliability";

      results.push({
        memoryId: mem.id,
        oldConfidence,
        newConfidence,
        reason,
      });

      if (!options.dryRun) {
        db.prepare("UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?").run(
          newConfidence,
          new Date().toISOString(),
          mem.id,
        );
      }
    }
  }

  return results;
}

export function deactivateLowConfidence(db: Database.Database, threshold: number = 0.1): number {
  const result = db.prepare(`
    UPDATE memories SET is_active = 0, updated_at = ?
    WHERE is_active = 1 AND confidence < ?
  `).run(new Date().toISOString(), threshold);
  return result.changes;
}
