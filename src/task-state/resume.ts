import { randomUUID } from "node:crypto";
import type { DB } from "../storage/connection.js";
import type { Platform } from "../core/types.js";
import { CheckpointService, type DriftReport } from "./checkpoints.js";

export interface ResumePacket { task: Record<string, unknown>; requirements: unknown[]; steps: unknown[]; decisions: unknown[]; failures: unknown[]; checkpoint: unknown; drift: DriftReport | null; immediate_next_action: string | null; }

export class ResumeCompiler {
  constructor(private readonly db: DB) {}

  compile(taskId: string, workspaceRoot?: string): ResumePacket {
    const task = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown> | undefined;
    if (!task) throw new Error("Task not found");
    const checkpointService = new CheckpointService(this.db);
    const checkpoint = checkpointService.latest(taskId);
    const steps = this.db.prepare(`SELECT * FROM task_steps WHERE task_id = ? ORDER BY position`).all(taskId) as Array<Record<string, unknown>>;
    return {
      task,
      requirements: this.db.prepare(`SELECT * FROM task_requirements WHERE task_id = ? ORDER BY created_at`).all(taskId),
      steps,
      decisions: this.db.prepare(`SELECT * FROM task_decisions WHERE task_id = ? AND status IN ('proposed','active') ORDER BY created_at`).all(taskId),
      failures: this.db.prepare(`SELECT * FROM task_failures WHERE task_id = ? ORDER BY created_at`).all(taskId),
      checkpoint,
      drift: workspaceRoot && checkpoint ? checkpointService.drift(taskId, workspaceRoot) : null,
      immediate_next_action: (steps.find((step) => step.status === "active") ?? steps.find((step) => step.status === "pending"))?.title as string ?? null,
    };
  }

  handoff(input: { taskId: string; source: Platform; target: Platform; workspaceRoot?: string; now?: number }): { id: string; packet: ResumePacket } {
    const packet = this.compile(input.taskId, input.workspaceRoot);
    const id = randomUUID(); const now = input.now ?? Date.now();
    this.db.prepare(`INSERT INTO handoffs (id, task_id, source_platform, target_platform, checkpoint_id, task_version, packet_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.taskId, input.source, input.target, (packet.checkpoint as { id?: string } | null)?.id ?? null, packet.task.version, JSON.stringify(packet), now);
    return { id, packet };
  }
}
