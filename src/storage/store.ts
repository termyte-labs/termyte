import { createHash } from "node:crypto";
import type { DatabaseContext, DB } from "./connection.js";
import { defaultDbPath, openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { redactTracePayload } from "../shared/redaction.js";
import type { Session, SessionHandoff, Trace } from "../shared/types.js";

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
