import { randomUUID } from "node:crypto";
import type { DB } from "../storage/connection.js";
import type { NormalizedEvent } from "../capture/adapter.js";
import type { TaskDetection, TaskDetectionDecision } from "./types.js";
import { TaskStateService } from "./service.js";

export interface TaskDetectionInput {
  event: NormalizedEvent;
  traceId?: number;
  repoId: string;
  workspaceRoot: string;
  now?: number;
}

export interface TaskDetectionResult {
  detection: TaskDetection;
  taskId: string | null;
}

/** Deterministic Work Thread assignment. LLM resolution can be layered on later. */
export class TaskDetectionService {
  private readonly tasks: TaskStateService;

  constructor(private readonly db: DB) { this.tasks = new TaskStateService(db); }

  detect(input: TaskDetectionInput): TaskDetectionResult {
    const now = input.now ?? input.event.timestamp;
    const prompt = clean(input.event.user_prompt);
    const files = unique([...(input.event.files_read ?? []), ...(input.event.files_modified ?? [])]);
    const terms = tokenize(prompt);
    const candidates = this.db.prepare(`SELECT * FROM tasks WHERE repo_id = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 20`).all(input.repoId) as TaskRow[];
    const scored = candidates.map((task) => scoreTask(task, input, files, terms));
    const best = scored.sort((a, b) => b.score - a.score)[0];
    let decision: TaskDetectionDecision;
    let taskId: string | null = null;
    let score = best?.score ?? 0;
    const evidence = best?.evidence ?? [];
    const signals = best?.signals ?? {};

    if (best && score >= 0.6) {
      decision = "continue";
      taskId = best.task.id;
    } else if (best && score >= 0.35) {
      decision = "uncertain";
    } else if (prompt) {
      decision = "new";
      const task = this.tasks.createTask({
        repoId: input.repoId,
        workspaceRoot: input.workspaceRoot,
        sessionId: input.event.session_id,
        title: prompt.slice(0, 160),
        objective: prompt,
        files,
        terms,
        confidence: 1,
        now,
      });
      taskId = task.id;
      score = 1;
      evidence.push("user_prompt");
      signals.prompt = 1;
    } else {
      decision = "uncertain";
    }

    const id = `detection_${randomUUID()}`;
    this.db.prepare(`INSERT INTO task_detections (id, task_id, session_id, repo_id, workspace_root, decision, score, evidence_json, signals_json, prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, taskId, input.event.session_id, input.repoId, input.workspaceRoot, decision, score, JSON.stringify(evidence), JSON.stringify(signals), prompt || null, now);

    if (taskId) {
      this.tasks.touchTask({ taskId, sessionId: input.event.session_id, workspaceRoot: input.workspaceRoot, files, terms, confidence: score, now });
      if (input.traceId !== undefined) this.db.prepare(`INSERT OR IGNORE INTO task_memberships (task_id, entity_type, entity_id, confidence, source_detection_id, created_at) VALUES (?, 'trace', ?, ?, ?, ?)`)
        .run(taskId, String(input.traceId), score, id, now);
    }

    return { detection: { id, task_id: taskId, session_id: input.event.session_id, repo_id: input.repoId, workspace_root: input.workspaceRoot, decision, score, evidence, signals, prompt: prompt || null, created_at: now }, taskId };
  }
}

interface TaskRow {
  id: string; last_session_id: string | null; workspace_root: string | null;
  last_files_json: string; last_terms_json: string; updated_at: number;
}

function scoreTask(task: TaskRow, input: TaskDetectionInput, files: string[], terms: string[]) {
  const signals: Record<string, number> = {};
  const evidence: string[] = [];
  let score = 0;
  if (task.last_session_id === input.event.session_id) { signals.session = 0.35; score += 0.35; evidence.push("session_continuity"); }
  if (task.workspace_root && task.workspace_root === input.workspaceRoot) { signals.workspace = 0.2; score += 0.2; evidence.push("workspace_match"); }
  const oldFiles = parseList(task.last_files_json);
  const overlap = files.length && oldFiles.length ? files.filter((file) => oldFiles.includes(file)).length / Math.max(files.length, oldFiles.length) : 0;
  if (overlap > 0) { signals.file_overlap = Math.min(0.3, overlap * 0.3); score += signals.file_overlap; evidence.push("file_overlap"); }
  const oldTerms = parseList(task.last_terms_json);
  const termOverlap = terms.length && oldTerms.length ? terms.filter((term) => oldTerms.includes(term)).length / Math.max(terms.length, oldTerms.length) : 0;
  if (termOverlap > 0) { signals.prompt_overlap = Math.min(0.35, termOverlap * 0.35); score += signals.prompt_overlap; evidence.push("prompt_overlap"); }
  if (input.event.timestamp - task.updated_at < 30 * 60_000) { signals.recency = 0.1; score += 0.1; evidence.push("recent_activity"); }
  return { task, score: Math.min(1, score), signals, evidence };
}

function parseList(value: string | null | undefined): string[] {
  try { const parsed = JSON.parse(value ?? "[]"); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []; } catch { return []; }
}

function tokenize(value: string): string[] { return unique(value.toLowerCase().split(/[^a-z0-9_./-]+/).filter((term) => term.length >= 3)); }
function unique(values: string[]): string[] { return [...new Set(values.filter(Boolean))]; }
function clean(value: string | null | undefined): string { return (value ?? "").replace(/\s+/g, " ").trim(); }
