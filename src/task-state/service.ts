import { randomUUID } from "node:crypto";
import type { DB } from "../storage/connection.js";
import type { EvidenceKind, EvidenceVerdict, StepStatus, Task, TaskStatus, TaskStep, VerificationEvidence } from "./types.js";

export class TaskVersionConflict extends Error {
  constructor() { super("Task was changed by another writer; reload and retry"); this.name = "TaskVersionConflict"; }
}

export class TaskStateService {
  constructor(private readonly db: DB) {}

  createTask(input: { repoId: string; title: string; objective: string; workspaceRoot?: string | null; sessionId?: string | null; files?: string[]; terms?: string[]; confidence?: number; now?: number }): Task {
    const now = input.now ?? Date.now();
    const task: Task = { id: randomUUID(), repo_id: input.repoId, title: input.title, objective: input.objective, status: "active", current_phase: null, current_step_id: null, version: 1, created_at: now, updated_at: now, workspace_root: input.workspaceRoot ?? null, last_session_id: input.sessionId ?? null, last_files: input.files ?? [], last_terms: input.terms ?? [], confidence: input.confidence ?? 1 };
    this.db.prepare(`INSERT INTO tasks (id, repo_id, title, objective, status, version, workspace_root, last_session_id, last_files_json, last_terms_json, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task.id, task.repo_id, task.title, task.objective, task.status, task.version, task.workspace_root, task.last_session_id, JSON.stringify(task.last_files), JSON.stringify(task.last_terms), task.confidence, now, now);
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as (Task & { last_files_json?: string; last_terms_json?: string }) | undefined;
    return row ? mapTask(row) : null;
  }

  touchTask(input: { taskId: string; sessionId: string; workspaceRoot?: string | null; files?: string[]; terms?: string[]; confidence?: number; now?: number }): void {
    const now = input.now ?? Date.now();
    this.db.prepare(`UPDATE tasks SET last_session_id = ?, workspace_root = COALESCE(?, workspace_root), last_files_json = ?, last_terms_json = ?, confidence = COALESCE(?, confidence), updated_at = ? WHERE id = ?`)
      .run(input.sessionId, input.workspaceRoot ?? null, JSON.stringify(input.files ?? []), JSON.stringify(input.terms ?? []), input.confidence ?? null, now, input.taskId);
  }

  addRequirement(input: { taskId: string; text: string; expectedVersion: number; now?: number }): Record<string, unknown> {
    const now = input.now ?? Date.now(); return this.db.transaction(() => {
      const version = this.bump(input.taskId, input.expectedVersion, now); const id = randomUUID();
      this.db.prepare(`INSERT INTO task_requirements (id, task_id, text, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)`).run(id, input.taskId, input.text, now, now);
      this.transition(input.taskId, "requirement", id, null, "active", "user", "requirement created", version, now);
      return this.db.prepare(`SELECT * FROM task_requirements WHERE id = ?`).get(id) as Record<string, unknown>;
    })();
  }

  confirmRequirement(input: { taskId: string; requirementId: string; expectedVersion: number; actor: "user" | "verifier"; now?: number }): void {
    const now = input.now ?? Date.now(); this.db.transaction(() => {
      const row = this.db.prepare(`SELECT status FROM task_requirements WHERE id = ? AND task_id = ?`).get(input.requirementId, input.taskId) as { status: string } | undefined;
      if (!row) throw new Error("Requirement not found"); const version = this.bump(input.taskId, input.expectedVersion, now);
      this.db.prepare(`UPDATE task_requirements SET status = 'satisfied', confirmation_kind = ?, updated_at = ? WHERE id = ?`).run(input.actor === "user" ? "user" : "deterministic-verifier", now, input.requirementId);
      this.transition(input.taskId, "requirement", input.requirementId, row.status, "satisfied", input.actor, null, version, now);
    })();
  }

  addDecision(input: { taskId: string; text: string; expectedVersion: number; actor: "user" | "agent"; now?: number }): Record<string, unknown> {
    const now = input.now ?? Date.now(); return this.db.transaction(() => {
      const version = this.bump(input.taskId, input.expectedVersion, now); const id = randomUUID(); const status = input.actor === "user" ? "active" : "proposed";
      this.db.prepare(`INSERT INTO task_decisions (id, task_id, text, status, confirmed_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.taskId, input.text, status, input.actor === "user" ? "user" : null, now, now);
      this.transition(input.taskId, "decision", id, null, status, input.actor, null, version, now);
      return this.db.prepare(`SELECT * FROM task_decisions WHERE id = ?`).get(id) as Record<string, unknown>;
    })();
  }

  recordFailure(input: { taskId: string; description: string; commandId?: string; exitCode?: number; userNote?: string; now?: number }): Record<string, unknown> {
    const id = randomUUID(); const now = input.now ?? Date.now();
    this.db.prepare(`INSERT INTO task_failures (id, task_id, description, command_id, exit_code, user_note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.taskId, input.description, input.commandId ?? null, input.exitCode ?? null, input.userNote ?? null, now);
    return this.db.prepare(`SELECT * FROM task_failures WHERE id = ?`).get(id) as Record<string, unknown>;
  }

  addStep(input: { taskId: string; title: string; position: number; verificationType?: string; expectedVersion: number; now?: number }): TaskStep {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const version = this.bump(input.taskId, input.expectedVersion, now);
      const step: TaskStep = { id: randomUUID(), task_id: input.taskId, title: input.title, position: input.position, status: "pending", verification_type: input.verificationType ?? null, created_at: now, updated_at: now };
      this.db.prepare(`INSERT INTO task_steps (id, task_id, title, position, status, verification_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(step.id, step.task_id, step.title, step.position, step.status, step.verification_type, now, now);
      this.transition(input.taskId, "step", step.id, null, "pending", "user", "step created", version, now);
      return step;
    })();
  }

  recordEvidence(input: { taskId: string; kind: EvidenceKind; verdict: EvidenceVerdict; traceId?: number; commandId?: string; payload?: Record<string, unknown>; now?: number }): VerificationEvidence {
    const evidence: VerificationEvidence = { id: randomUUID(), task_id: input.taskId, evidence_kind: input.kind, trace_id: input.traceId ?? null, command_id: input.commandId ?? null, payload: input.payload ?? {}, verdict: input.verdict, created_at: input.now ?? Date.now() };
    this.db.prepare(`INSERT INTO verification_evidence (id, task_id, evidence_kind, trace_id, command_id, payload_json, verdict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(evidence.id, evidence.task_id, evidence.evidence_kind, evidence.trace_id, evidence.command_id, JSON.stringify(evidence.payload), evidence.verdict, evidence.created_at);
    return evidence;
  }

  updateStep(input: { taskId: string; stepId: string; status: StepStatus; expectedVersion: number; evidenceIds?: string[]; actor: "user" | "verifier" | "agent"; reason?: string; now?: number }): TaskStep {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const step = this.db.prepare(`SELECT * FROM task_steps WHERE id = ? AND task_id = ?`).get(input.stepId, input.taskId) as TaskStep | undefined;
      if (!step) throw new Error("Task step not found");
      const evidenceIds = input.evidenceIds ?? [];
      if (input.status === "verified") {
        if (input.actor === "agent") throw new Error("Agent statements cannot verify a step");
        if (evidenceIds.length === 0) throw new Error("Verified steps require evidence");
        const placeholders = evidenceIds.map(() => "?").join(",");
        const accepted = (this.db.prepare(`SELECT COUNT(*) AS n FROM verification_evidence WHERE task_id = ? AND id IN (${placeholders}) AND verdict = 'passed' AND evidence_kind IN ('command','test','git','file','user')`).get(input.taskId, ...evidenceIds) as { n: number }).n;
        if (accepted !== evidenceIds.length) throw new Error("All verification evidence must belong to the task and pass");
      }
      const version = this.bump(input.taskId, input.expectedVersion, now);
      this.db.prepare(`UPDATE task_steps SET status = ?, updated_at = ? WHERE id = ?`).run(input.status, now, input.stepId);
      const link = this.db.prepare(`INSERT OR IGNORE INTO task_step_evidence (step_id, evidence_id) VALUES (?, ?)`);
      for (const id of evidenceIds) link.run(input.stepId, id);
      this.transition(input.taskId, "step", input.stepId, step.status, input.status, input.actor, input.reason ?? null, version, now);
      return { ...step, status: input.status, updated_at: now };
    })();
  }

  updateTaskStatus(input: { taskId: string; status: TaskStatus; expectedVersion: number; actor: "user" | "verifier"; now?: number }): Task {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const task = this.getTask(input.taskId); if (!task) throw new Error("Task not found");
      if (input.status === "completed") {
        const unverified = (this.db.prepare(`SELECT COUNT(*) AS n FROM task_steps WHERE task_id = ? AND status <> 'verified'`).get(input.taskId) as { n: number }).n;
        const requirements = (this.db.prepare(`SELECT COUNT(*) AS n FROM task_requirements WHERE task_id = ? AND status = 'active'`).get(input.taskId) as { n: number }).n;
        if (unverified || requirements) throw new Error("Task completion requires verified steps and satisfied requirements");
      }
      const version = this.bump(input.taskId, input.expectedVersion, now);
      this.db.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(input.status, input.taskId);
      this.transition(input.taskId, "task", input.taskId, task.status, input.status, input.actor, null, version, now);
      return this.getTask(input.taskId)!;
    })();
  }

  private bump(taskId: string, expectedVersion: number, now: number): number {
    const result = this.db.prepare(`UPDATE tasks SET version = version + 1, updated_at = ? WHERE id = ? AND version = ?`).run(now, taskId, expectedVersion);
    if (result.changes !== 1) throw new TaskVersionConflict();
    return expectedVersion + 1;
  }

  private transition(taskId: string, entityType: string, entityId: string, from: string | null, to: string, actor: string, reason: string | null, version: number, now: number): void {
    this.db.prepare(`INSERT INTO task_transitions (id, task_id, entity_type, entity_id, from_status, to_status, actor_type, reason, task_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), taskId, entityType, entityId, from, to, actor, reason, version, now);
  }
}

function mapTask(row: Task & { last_files_json?: string; last_terms_json?: string }): Task {
  return {
    ...row,
    last_files: parseList(row.last_files_json),
    last_terms: parseList(row.last_terms_json),
  };
}

function parseList(value: string | undefined): string[] {
  try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}
