import { randomUUID } from "node:crypto";
import type { DB } from "../storage/connection.js";
import type { Platform } from "../core/types.js";
import { readRepositoryState } from "../experience/git-state.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Checkpoint {
  id: string; task_id: string; session_id: string | null; platform: Platform;
  branch: string | null; commit_hash: string | null; changed_files: string[]; conflicts: string[]; created_at: number;
}

export interface DriftReport {
  branch_changed: boolean; commit_changed: boolean; working_tree_dirty: boolean;
  changed_files: string[]; deleted_files: string[]; conflicts: string[];
}

export class CheckpointService {
  constructor(private readonly db: DB) {}

  create(input: { taskId: string; workspaceRoot: string; platform: Platform; sessionId?: string; now?: number }): Checkpoint {
    const state = readRepositoryState(input.workspaceRoot);
    if (!state) throw new Error("Checkpoint requires a Git repository");
    const changed = [...new Set([...state.stagedPaths, ...state.unstagedPaths, ...state.untrackedPaths])].sort();
    const checkpoint: Checkpoint = { id: randomUUID(), task_id: input.taskId, session_id: input.sessionId ?? null, platform: input.platform, branch: state.branch, commit_hash: state.head, changed_files: changed, conflicts: state.conflicts, created_at: input.now ?? Date.now() };
    this.db.prepare(`INSERT INTO checkpoints (id, task_id, session_id, platform, branch, commit_hash, changed_files_json, conflicts_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(checkpoint.id, checkpoint.task_id, checkpoint.session_id, checkpoint.platform, checkpoint.branch, checkpoint.commit_hash, JSON.stringify(changed), JSON.stringify(checkpoint.conflicts), checkpoint.created_at);
    return checkpoint;
  }

  latest(taskId: string): Checkpoint | null {
    const row = this.db.prepare(`SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at DESC LIMIT 1`).get(taskId) as any;
    return row ? { ...row, changed_files: parseArray(row.changed_files_json), conflicts: parseArray(row.conflicts_json) } : null;
  }

  drift(taskId: string, workspaceRoot: string): DriftReport {
    const checkpoint = this.latest(taskId); if (!checkpoint) throw new Error("No checkpoint exists for task");
    const state = readRepositoryState(workspaceRoot); if (!state) throw new Error("Drift check requires a Git repository");
    const current = [...new Set([...state.stagedPaths, ...state.unstagedPaths, ...state.untrackedPaths])].sort();
    return {
      branch_changed: checkpoint.branch !== state.branch,
      commit_changed: checkpoint.commit_hash !== state.head,
      working_tree_dirty: current.length > 0,
      changed_files: current,
      deleted_files: current.filter((path) => !state.untrackedPaths.includes(path) && !existsSync(join(workspaceRoot, path))),
      conflicts: state.conflicts,
    };
  }
}

function parseArray(raw: string): string[] { try { const value = JSON.parse(raw); return Array.isArray(value) ? value : []; } catch { return []; } }
