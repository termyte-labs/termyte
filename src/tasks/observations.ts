import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DB } from "../storage/connection.js";
import type { WorkThreadObservation, WorkThreadObservationKind } from "./types.js";

export const WorkThreadObservationSchema = z.object({
  task_id: z.string().min(1),
  kind: z.enum(["requirement", "decision", "discovery", "attempt", "failure", "warning", "verification"]),
  claim: z.string().min(1).max(4_000),
  reason: z.string().max(4_000).nullable().optional(),
  confidence: z.number().min(0).max(1).default(0.5),
  files: z.array(z.string()).default([]),
  source_event_ids: z.array(z.number().int().positive()).min(1),
});

export type WorkThreadObservationInput = z.input<typeof WorkThreadObservationSchema>;

export class WorkThreadObservationStore {
  constructor(private readonly db: DB) {}

  insert(raw: WorkThreadObservationInput, now = Date.now()): WorkThreadObservation {
    const parsed = WorkThreadObservationSchema.parse(raw);
    const id = `wt_observation_${randomUUID()}`;
    this.db.transaction(() => {
      const valid = this.db.prepare(`SELECT COUNT(*) AS n FROM traces WHERE id IN (${parsed.source_event_ids.map(() => "?").join(",")})`).get(...parsed.source_event_ids) as { n: number };
      if (valid.n !== parsed.source_event_ids.length) throw new Error("Every Work Thread observation must reference an existing trace");
      this.db.prepare(`INSERT INTO task_observations (id, task_id, kind, claim, reason, confidence, files_json, source_event_ids_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, parsed.task_id, parsed.kind, parsed.claim, parsed.reason ?? null, parsed.confidence, JSON.stringify(parsed.files), JSON.stringify(parsed.source_event_ids), now, now);
      const link = this.db.prepare(`INSERT INTO task_observation_evidence (observation_id, trace_id) VALUES (?, ?)`);
      for (const traceId of parsed.source_event_ids) link.run(id, traceId);
      this.db.prepare(`INSERT OR IGNORE INTO task_memberships (task_id, entity_type, entity_id, confidence, created_at) VALUES (?, 'observation', ?, ?, ?)`)
        .run(parsed.task_id, id, parsed.confidence, now);
    })();
    return this.get(id)!;
  }

  get(id: string): WorkThreadObservation | null {
    const row = this.db.prepare(`SELECT * FROM task_observations WHERE id = ?`).get(id) as Row | undefined;
    return row ? map(row) : null;
  }

  list(taskId: string, limit = 100): WorkThreadObservation[] {
    return (this.db.prepare(`SELECT * FROM task_observations WHERE task_id = ? AND lifecycle_state = 'active' ORDER BY created_at DESC LIMIT ?`).all(taskId, limit) as Row[]).map(map);
  }

  updateLifecycle(id: string, state: WorkThreadObservation["lifecycle_state"]): void {
    this.db.prepare(`UPDATE task_observations SET lifecycle_state = ?, updated_at = ? WHERE id = ?`).run(state, Date.now(), id);
  }
}

interface Row { id: string; task_id: string; kind: WorkThreadObservationKind; claim: string; reason: string | null; confidence: number; lifecycle_state: WorkThreadObservation["lifecycle_state"]; files_json: string; source_event_ids_json: string; created_at: number; updated_at: number; }
function map(row: Row): WorkThreadObservation { return { id: row.id, task_id: row.task_id, kind: row.kind, claim: row.claim, reason: row.reason, confidence: row.confidence, lifecycle_state: row.lifecycle_state, files: parse(row.files_json), source_event_ids: parseNumbers(row.source_event_ids_json), created_at: row.created_at, updated_at: row.updated_at }; }
function parse(value: string): string[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; } }
function parseNumbers(value: string): number[] { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is number => typeof item === "number") : []; } catch { return []; } }
