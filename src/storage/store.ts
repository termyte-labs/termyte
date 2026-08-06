import { createHash } from "node:crypto";
import type { DatabaseContext, DB } from "./connection.js";
import { defaultDbPath, openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { redactTracePayload } from "../shared/redaction.js";
import type { Experience, ReflectionJob, Session, SessionHandoff, Trace } from "../shared/types.js";

type TraceInput = Omit<Trace, "id" | "redaction">;

export class Store {
  private readonly ctx: DatabaseContext;

  constructor(pathOrContext: string | DatabaseContext = defaultDbPath()) {
    this.ctx = typeof pathOrContext === "string" ? openDatabase(pathOrContext) : pathOrContext;
    runMigrations(this.ctx.db);
  }

  getDB(): DB { return this.ctx.db; }
  getPath(): string { return this.ctx.dbPath; }
  close(): void { this.ctx.db.close(); }

  upsertSession(sessionId: string, project: string, repoId?: string, workspaceRoot?: string): Session {
    const now = Date.now();
    this.ctx.db.prepare(`
      INSERT INTO sessions (session_id, project, repo_id, workspace_root, started_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project = excluded.project,
        repo_id = COALESCE(excluded.repo_id, sessions.repo_id),
        workspace_root = COALESCE(excluded.workspace_root, sessions.workspace_root)
    `).run(sessionId, project, repoId ?? null, workspaceRoot ?? null, now);
    return this.getSession(sessionId)!;
  }

  getSession(sessionId: string): Session | null {
    const row = this.ctx.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`).get(sessionId);
    return row ? mapSession(row) : null;
  }

  migrateLegacyLocalRepository(legacyRepoId: string, repoId: string, workspaceRoot: string): void {
    if (!repoId.startsWith("local:") || legacyRepoId === repoId) return;
    this.ctx.db.transaction(() => {
      const matchingSessions = `SELECT session_id FROM sessions WHERE repo_id = ? AND workspace_root = ?`;
      this.ctx.db.prepare(`UPDATE experiences SET repository_id = ? WHERE repository_id = ? AND source_session_id IN (${matchingSessions})`)
        .run(repoId, legacyRepoId, legacyRepoId, workspaceRoot);
      this.ctx.db.prepare(`UPDATE reflection_jobs SET repository_id = ? WHERE repository_id = ? AND source_session_id IN (${matchingSessions})`)
        .run(repoId, legacyRepoId, legacyRepoId, workspaceRoot);
      this.ctx.db.prepare(`UPDATE handoffs SET repo_id = ? WHERE repo_id = ? AND source_session_id IN (${matchingSessions})`)
        .run(repoId, legacyRepoId, legacyRepoId, workspaceRoot);
      this.ctx.db.prepare(`UPDATE sessions SET repo_id = ? WHERE repo_id = ? AND workspace_root = ?`)
        .run(repoId, legacyRepoId, workspaceRoot);
    })();
  }

  endSession(sessionId: string, now = Date.now()): void {
    this.ctx.db.prepare(`UPDATE sessions SET ended_at = COALESCE(ended_at, ?) WHERE session_id = ?`).run(now, sessionId);
  }

  getPreviousSession(repoId: string, currentSessionId: string): Session | null {
    const row = this.ctx.db.prepare(`
      SELECT s.* FROM sessions s
      WHERE s.repo_id = ? AND s.session_id <> ?
        AND EXISTS (SELECT 1 FROM traces t WHERE t.session_id = s.session_id)
      ORDER BY COALESCE(s.ended_at, s.started_at) DESC
      LIMIT 1
    `).get(repoId, currentSessionId);
    return row ? mapSession(row) : null;
  }

  insertTraceIdempotent(trace: TraceInput): { trace: Trace; inserted: boolean } {
    const redacted = redactTracePayload({
      tool_input: trace.tool_input,
      tool_output: trace.tool_output,
      user_prompt: trace.user_prompt,
      final_response: trace.final_response,
    });
    const contentHash = createHash("sha256").update(JSON.stringify({
      event_type: trace.event_type,
      tool_name: trace.tool_name,
      tool_input: redacted.value.tool_input,
      tool_output: redacted.value.tool_output,
      files_read: trace.files_read,
      files_modified: trace.files_modified,
      user_prompt: redacted.value.user_prompt,
      final_response: redacted.value.final_response,
    })).digest("hex");
    const info = this.ctx.db.prepare(`
      INSERT OR IGNORE INTO traces (
        session_id, platform_event_id, timestamp, event_type, tool_name,
        tool_input, tool_output, files_read, files_modified, user_prompt,
        final_response, redaction_json, content_hash, ingested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      trace.session_id, trace.platform_event_id, trace.timestamp, trace.event_type, trace.tool_name,
      json(redacted.value.tool_input), json(redacted.value.tool_output), json(trace.files_read),
      json(trace.files_modified), redacted.value.user_prompt, redacted.value.final_response,
      json(redacted.redaction), contentHash, Date.now(),
    );
    const row = info.changes === 1
      ? this.ctx.db.prepare(`SELECT * FROM traces WHERE id = ?`).get(info.lastInsertRowid)
      : trace.platform_event_id
        ? this.ctx.db.prepare(`SELECT * FROM traces WHERE session_id = ? AND platform_event_id = ?`).get(trace.session_id, trace.platform_event_id)
        : this.ctx.db.prepare(`SELECT * FROM traces WHERE session_id = ? AND event_type = ? AND timestamp = ? AND content_hash = ?`).get(trace.session_id, trace.event_type, trace.timestamp, contentHash);
    if (!row) throw new Error("Failed to persist trace");
    return { trace: mapTrace(row), inserted: info.changes === 1 };
  }

  getTracesForSession(sessionId: string): Trace[] {
    return this.ctx.db.prepare(`SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp, id`).all(sessionId).map(mapTrace);
  }

  getRecentSessions(repoId: string, excludeSessionId?: string, limit = 8): Session[] {
    return this.ctx.db.prepare(`
      SELECT * FROM sessions
      WHERE repo_id = ? AND (? IS NULL OR session_id <> ?)
      ORDER BY COALESCE(ended_at, started_at) DESC
      LIMIT ?
    `).all(repoId, excludeSessionId ?? null, excludeSessionId ?? null, limit).map(mapSession);
  }

  saveExperience(input: Omit<Experience, "created_at"> & { created_at?: number }): Experience {
    this.ctx.db.prepare(`
      INSERT INTO experiences (id, repository_id, source_session_id, content, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_session_id) DO NOTHING
    `).run(input.id, input.repository_id, input.source_session_id, input.content, input.evidence, input.created_at ?? Date.now());
    return this.getExperienceForSession(input.source_session_id)!;
  }

  getExperienceForSession(sessionId: string): Experience | null {
    const row = this.ctx.db.prepare(`SELECT * FROM experiences WHERE source_session_id = ?`).get(sessionId);
    return row ? mapExperience(row) : null;
  }

  listExperiences(repoId: string): Experience[] {
    return this.ctx.db.prepare(`
      SELECT * FROM experiences WHERE repository_id = ? ORDER BY created_at DESC, id
    `).all(repoId).map(mapExperience);
  }

  getExperiencesByIds(repoId: string, ids: string[]): Experience[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.ctx.db.prepare(`
      SELECT * FROM experiences WHERE repository_id = ? AND id IN (${placeholders})
    `).all(repoId, ...ids).map(mapExperience);
    const byId = new Map(rows.map((item) => [item.id, item]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }

  enqueueReflectionJob(repositoryId: string, sourceSessionId: string, now = Date.now()): ReflectionJob {
    this.ctx.db.prepare(`
      INSERT INTO reflection_jobs (
        repository_id, source_session_id, status, attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, 'queued', 0, ?, ?, ?)
      ON CONFLICT(source_session_id) DO NOTHING
    `).run(repositoryId, sourceSessionId, now, now, now);
    return this.getReflectionJobForSession(sourceSessionId)!;
  }

  getReflectionJobForSession(sessionId: string): ReflectionJob | null {
    const row = this.ctx.db.prepare(`SELECT * FROM reflection_jobs WHERE source_session_id = ?`).get(sessionId);
    return row ? mapReflectionJob(row) : null;
  }

  hasRunnableReflectionJobs(now = Date.now()): boolean {
    const row = this.ctx.db.prepare(`
      SELECT 1 AS ready FROM reflection_jobs
      WHERE (status = 'queued' AND available_at <= ?)
         OR (status = 'running' AND lease_expires_at <= ?)
      LIMIT 1
    `).get(now, now) as { ready?: number } | undefined;
    return row?.ready === 1;
  }

  claimReflectionJob(now = Date.now(), leaseMs = 120_000): ReflectionJob | null {
    return this.ctx.db.transaction(() => {
      const row = this.ctx.db.prepare(`
        SELECT * FROM reflection_jobs
        WHERE (status = 'queued' AND available_at <= ?)
           OR (status = 'running' AND lease_expires_at <= ?)
        ORDER BY available_at, id
        LIMIT 1
      `).get(now, now);
      if (!row) return null;
      const job = mapReflectionJob(row);
      this.ctx.db.prepare(`
        UPDATE reflection_jobs
        SET status = 'running', attempts = attempts + 1, lease_expires_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now + leaseMs, now, job.id);
      const claimed = this.ctx.db.prepare(`SELECT * FROM reflection_jobs WHERE id = ?`).get(job.id);
      return claimed ? mapReflectionJob(claimed) : null;
    })();
  }

  nextQueuedReflectionDelay(now = Date.now()): number | null {
    const row = this.ctx.db.prepare(`
      SELECT MIN(available_at) AS next_at FROM reflection_jobs WHERE status = 'queued'
    `).get() as { next_at?: number | null } | undefined;
    return typeof row?.next_at === "number" ? Math.max(0, row.next_at - now) : null;
  }

  completeReflectionJob(id: number, now = Date.now()): void {
    this.ctx.db.prepare(`
      UPDATE reflection_jobs
      SET status = 'completed', lease_expires_at = NULL, last_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(now, id);
  }

  failReflectionJob(id: number, error: string, now = Date.now(), maxAttempts = 3): void {
    const current = this.ctx.db.prepare(`SELECT attempts FROM reflection_jobs WHERE id = ?`).get(id) as { attempts?: number } | undefined;
    const attempts = current?.attempts ?? maxAttempts;
    const terminal = attempts >= maxAttempts;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1));
    this.ctx.db.prepare(`
      UPDATE reflection_jobs
      SET status = ?, available_at = ?, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(terminal ? "failed" : "queued", now + delay, error.slice(0, 2_000), now, id);
  }

  getHandoff(sourceSessionId: string): SessionHandoff | null {
    const row = this.ctx.db.prepare(`SELECT * FROM handoffs WHERE source_session_id = ?`).get(sourceSessionId);
    return row ? mapHandoff(row) : null;
  }

  saveHandoff(input: { sourceSessionId: string; targetSessionId: string; repoId: string; content: string }): SessionHandoff {
    this.ctx.db.prepare(`
      INSERT INTO handoffs (source_session_id, target_session_id, repo_id, content, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source_session_id) DO UPDATE SET
        target_session_id = excluded.target_session_id,
        repo_id = excluded.repo_id,
        content = excluded.content,
        created_at = excluded.created_at
    `).run(input.sourceSessionId, input.targetSessionId, input.repoId, input.content, Date.now());
    return this.getHandoff(input.sourceSessionId)!;
  }

  searchHandoffs(repoId: string, query: string, limit = 3): SessionHandoff[] {
    const terms = [...new Set(query.toLowerCase().match(/[a-z0-9_./-]{3,}/g) ?? [])].slice(0, 12);
    if (terms.length === 0) return [];
    const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
    return this.ctx.db.prepare(`
      SELECT h.* FROM handoffs_fts f
      JOIN handoffs h ON h.id = f.rowid
      WHERE handoffs_fts MATCH ? AND h.repo_id = ?
      ORDER BY bm25(handoffs_fts), h.created_at DESC
      LIMIT ?
    `).all(match, repoId, limit).map(mapHandoff);
  }
}

function json(value: unknown): string | null { return value == null ? null : JSON.stringify(value); }
function parse(value: unknown): unknown { if (typeof value !== "string") return value ?? null; try { return JSON.parse(value); } catch { return value; } }
function strings(value: unknown): string[] | null { const parsed = parse(value); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : null; }
function mapSession(row: any): Session { return { id: row.id, session_id: row.session_id, project: row.project, repo_id: row.repo_id, workspace_root: row.workspace_root, started_at: row.started_at, ended_at: row.ended_at }; }
function mapTrace(row: any): Trace { return { id: row.id, session_id: row.session_id, platform_event_id: row.platform_event_id ?? null, timestamp: row.timestamp, event_type: row.event_type, tool_name: row.tool_name, tool_input: parse(row.tool_input), tool_output: parse(row.tool_output), files_read: strings(row.files_read), files_modified: strings(row.files_modified), user_prompt: row.user_prompt, final_response: row.final_response, redaction: parse(row.redaction_json) }; }
function mapHandoff(row: any): SessionHandoff { return { id: row.id, source_session_id: row.source_session_id, target_session_id: row.target_session_id, repo_id: row.repo_id, content: row.content, created_at: row.created_at }; }
function mapExperience(row: any): Experience { return { id: row.id, repository_id: row.repository_id, source_session_id: row.source_session_id, content: row.content, evidence: row.evidence, created_at: row.created_at }; }
function mapReflectionJob(row: any): ReflectionJob { return { id: row.id, repository_id: row.repository_id, source_session_id: row.source_session_id, status: row.status, attempts: row.attempts, available_at: row.available_at, lease_expires_at: row.lease_expires_at, last_error: row.last_error, created_at: row.created_at, updated_at: row.updated_at }; }
