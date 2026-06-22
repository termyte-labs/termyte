import type Database from "better-sqlite3";
import type { Session, Event, CaptureEvent, EventStatus, SessionStatus } from "../types.js";
import { generateId, nowISO } from "../utils.js";

export class CaptureEngine {
  constructor(private readonly db: Database.Database) {}

  startSession(agent: string, workspaceRoot: string, branch?: string): Session {
    const id = generateId();
    const now = nowISO();
    this.db.prepare(`
      INSERT INTO sessions (id, agent, workspace_root, branch, started_at, status)
      VALUES (?, ?, ?, ?, ?, 'running')
    `).run(id, agent, workspaceRoot, branch ?? null, now);
    return { id, agent, workspaceRoot, branch, startedAt: now, status: "running" };
  }

  endSession(sessionId: string, status: SessionStatus = "completed", summary?: string): void {
    this.db.prepare(`
      UPDATE sessions SET ended_at = ?, status = ?, summary = ? WHERE id = ?
    `).run(nowISO(), status, summary ?? null, sessionId);
  }

  recordEvent(input: CaptureEvent): Event {
    const id = generateId();
    const now = nowISO();
    this.db.prepare(`
      INSERT INTO events (id, session_id, timestamp, source, actor_type, actor_name, event_type, status, summary, confidence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1.0)
    `).run(id, input.sessionId, now, input.source, input.actorType, input.actorName ?? null, input.eventType, "succeeded" satisfies EventStatus, input.summary);

    if (input.rawPayload !== undefined) {
      this.db.prepare(`
        INSERT INTO raw_payloads (event_id, raw_json, redacted, schema_version)
        VALUES (?, ?, 0, 1)
      `).run(id, JSON.stringify(input.rawPayload));
    }

    return {
      id,
      sessionId: input.sessionId,
      timestamp: now,
      source: input.source,
      actorType: input.actorType,
      actorName: input.actorName,
      eventType: input.eventType,
      status: "succeeded",
      summary: input.summary,
      confidence: 1.0,
    };
  }

  recordCommandEvent(
    sessionId: string,
    command: string,
    options: {
      shell?: string;
      cwd?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      durationMs?: number;
      semanticId?: string;
    } = {},
  ): Event {
    const event = this.recordEvent({
      sessionId,
      source: "cli",
      actorType: "agent",
      eventType: "command",
      summary: command,
    });

    this.db.prepare(`
      INSERT INTO command_events (event_id, command, shell, cwd, exit_code, stdout_excerpt, stderr_excerpt, duration_ms, semantic_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      command,
      options.shell ?? null,
      options.cwd ?? null,
      options.exitCode ?? null,
      options.stdout ? options.stdout.slice(0, 1000) : null,
      options.stderr ? options.stderr.slice(0, 1000) : null,
      options.durationMs ?? null,
      options.semanticId ?? null,
    );

    return event;
  }

  getEvents(sessionId: string): Event[] {
    const rows = this.db.prepare(`
      SELECT id, session_id, timestamp, source, actor_type, actor_name, event_type, status, summary, correlation_id, confidence
      FROM events WHERE session_id = ? ORDER BY timestamp
    `).all(sessionId) as Array<{
      id: string;
      session_id: string;
      timestamp: string;
      source: string;
      actor_type: string;
      actor_name: string | null;
      event_type: string;
      status: string;
      summary: string;
      correlation_id: string | null;
      confidence: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      timestamp: r.timestamp,
      source: r.source as Event["source"],
      actorType: r.actor_type as Event["actorType"],
      actorName: r.actor_name ?? undefined,
      eventType: r.event_type as Event["eventType"],
      status: r.status as Event["status"],
      summary: r.summary,
      correlationId: r.correlation_id ?? undefined,
      confidence: r.confidence,
    }));
  }

  getSession(id: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as {
      id: string;
      agent: string;
      workspace_root: string;
      branch: string | null;
      start_commit: string | null;
      end_commit: string | null;
      started_at: string;
      ended_at: string | null;
      status: string;
      summary: string | null;
    } | undefined;
    if (!row) return null;
    return {
      id: row.id,
      agent: row.agent,
      workspaceRoot: row.workspace_root,
      branch: row.branch ?? undefined,
      startCommit: row.start_commit ?? undefined,
      endCommit: row.end_commit ?? undefined,
      startedAt: row.started_at,
      endedAt: row.ended_at ?? undefined,
      status: row.status as SessionStatus,
      summary: row.summary ?? undefined,
    };
  }

  listSessions(limit = 20): Session[] {
    const rows = this.db.prepare("SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?").all(limit) as Array<{
      id: string;
      agent: string;
      workspace_root: string;
      branch: string | null;
      start_commit: string | null;
      end_commit: string | null;
      started_at: string;
      ended_at: string | null;
      status: string;
      summary: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      agent: r.agent,
      workspaceRoot: r.workspace_root,
      branch: r.branch ?? undefined,
      startCommit: r.start_commit ?? undefined,
      endCommit: r.end_commit ?? undefined,
      startedAt: r.started_at,
      endedAt: r.ended_at ?? undefined,
      status: r.status as SessionStatus,
      summary: r.summary ?? undefined,
    }));
  }
}
