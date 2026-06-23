import type Database from "better-sqlite3";
import type { Memory, MemoryFeedback } from "../types.js";
import { updateConfidenceOnOutcome } from "./confidence.js";

export interface OutcomeRecord {
  sessionId: string;
  memoryId: string;
  outcome: "success" | "failure";
  context?: string;
}

export function recordOutcome(
  db: Database.Database,
  input: OutcomeRecord,
): Memory | null {
  const memory = db.prepare("SELECT * FROM memories WHERE id = ?").get(input.memoryId) as any;
  if (!memory) return null;

  const toMemory = (row: any): Memory => ({
    id: row.id,
    claim: row.claim,
    type: row.type,
    repoScope: row.repo_scope,
    language: row.language ?? undefined,
    sources: JSON.parse(row.sources ?? "[]"),
    successCount: row.success_count,
    failureCount: row.failure_count,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active === 1,
  });

  const mem = toMemory(memory);
  const newConfidence = updateConfidenceOnOutcome(mem, input.outcome);
  const now = new Date().toISOString();

  if (input.outcome === "success") {
    db.prepare(`
      UPDATE memories
      SET success_count = success_count + 1, confidence = ?, updated_at = ?, last_outcome_at = ?, last_outcome_type = 'success'
      WHERE id = ?
    `).run(newConfidence, now, now, input.memoryId);
  } else {
    db.prepare(`
      UPDATE memories
      SET failure_count = failure_count + 1, confidence = ?, updated_at = ?, last_outcome_at = ?, last_outcome_type = 'failure'
      WHERE id = ?
    `).run(newConfidence, now, now, input.memoryId);
  }

  return {
    ...mem,
    successCount: mem.successCount + (input.outcome === "success" ? 1 : 0),
    failureCount: mem.failureCount + (input.outcome === "failure" ? 1 : 0),
    confidence: newConfidence,
    updatedAt: now,
  };
}

export function recordOutcomeAndFeedback(
  db: Database.Database,
  input: OutcomeRecord & { outcomeDetail?: string },
): { memory: Memory | null; feedback: MemoryFeedback } {
  const memory = recordOutcome(db, input);

  const stmt = db.prepare(`
    INSERT INTO memory_feedback (memory_id, used_at, context, outcome, outcome_detail, session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    input.memoryId,
    new Date().toISOString(),
    input.context ?? null,
    input.outcome,
    input.outcomeDetail ?? null,
    input.sessionId ?? null,
  );

  const feedback: MemoryFeedback = {
    id: Number(result.lastInsertRowid),
    memoryId: input.memoryId,
    usedAt: new Date().toISOString(),
    context: input.context,
    outcome: input.outcome,
    outcomeDetail: input.outcomeDetail,
    sessionId: input.sessionId,
  };

  return { memory, feedback };
}
