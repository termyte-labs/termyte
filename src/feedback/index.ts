import type Database from "better-sqlite3";
import type { MemoryFeedback } from "../types.js";

export function recordFeedback(
  db: Database.Database,
  memoryId: string,
  outcome: "success" | "failure" | "ignored",
  options: { context?: string; outcomeDetail?: string; sessionId?: string } = {},
): MemoryFeedback {
  const stmt = db.prepare(`
    INSERT INTO memory_feedback (memory_id, used_at, context, outcome, outcome_detail, session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    memoryId,
    new Date().toISOString(),
    options.context ?? null,
    outcome,
    options.outcomeDetail ?? null,
    options.sessionId ?? null,
  );

  return {
    id: Number(result.lastInsertRowid),
    memoryId,
    usedAt: new Date().toISOString(),
    context: options.context,
    outcome,
    outcomeDetail: options.outcomeDetail,
    sessionId: options.sessionId,
  };
}

export function getFeedbackForMemory(db: Database.Database, memoryId: string): MemoryFeedback[] {
  const rows = db.prepare(`
    SELECT id, memory_id, used_at, context, outcome, outcome_detail, session_id
    FROM memory_feedback WHERE memory_id = ? ORDER BY used_at DESC
  `).all(memoryId) as Array<{
    id: number;
    memory_id: string;
    used_at: string;
    context: string | null;
    outcome: string;
    outcome_detail: string | null;
    session_id: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    memoryId: r.memory_id,
    usedAt: r.used_at,
    context: r.context ?? undefined,
    outcome: r.outcome as MemoryFeedback["outcome"],
    outcomeDetail: r.outcome_detail ?? undefined,
    sessionId: r.session_id ?? undefined,
  }));
}

export function getFeedbackStats(db: Database.Database, memoryId: string): {
  total: number;
  successes: number;
  failures: number;
  ignored: number;
} {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
      SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
      SUM(CASE WHEN outcome = 'ignored' THEN 1 ELSE 0 END) as ignored
    FROM memory_feedback WHERE memory_id = ?
  `).get(memoryId) as { total: number; successes: number; failures: number; ignored: number };
  return {
    total: row.total,
    successes: row.successes,
    failures: row.failures,
    ignored: row.ignored,
  };
}
