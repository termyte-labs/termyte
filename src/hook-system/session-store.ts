import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { NormalizedHookInput, Session, PlatformSource, SessionStatus } from "../types.js";
import { nowISO, fingerprint } from "../utils.js";

export interface CreateSessionInput {
  contentSessionId?: string;
  memorySessionId?: string;
  project: string;
  platformSource: PlatformSource;
  userPrompt?: string;
}

export interface UpdateSessionInput {
  completedAt?: string;
  completedAtEpoch?: number;
  status?: SessionStatus;
  promptCounter?: number;
  customTitle?: string;
  memorySessionId?: string;
}

export interface ListSessionsOptions {
  project?: string;
  limit?: number;
  offset?: number;
}

export class SessionStore {
  constructor(private db: Database.Database) {}

  createSession(input: CreateSessionInput): Session {
    const contentSessionId = input.contentSessionId ?? randomUUID();
    const memorySessionId = input.memorySessionId ?? randomUUID();
    const now = nowISO();
    const nowEpoch = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO sessions (content_session_id, memory_session_id, project, platform_source, user_prompt, started_at, started_at_epoch, status, prompt_counter)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0)
    `);

    stmt.run(contentSessionId, memorySessionId, input.project, input.platformSource, input.userPrompt ?? null, now, nowEpoch);

    return this.getSessionByContentId(contentSessionId)!;
  }

  getSessionByContentId(contentSessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE content_session_id = ?").get(contentSessionId) as any;
    return row ? this.rowToSession(row) : null;
  }

  getSessionByMemoryId(memorySessionId: string): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE memory_session_id = ?").get(memorySessionId) as any;
    return row ? this.rowToSession(row) : null;
  }

  updateSession(contentSessionId: string, input: UpdateSessionInput): void {
    const sets: string[] = [];
    const values: unknown[] = [];

    if (input.completedAt !== undefined) { sets.push("completed_at = ?"); values.push(input.completedAt); }
    if (input.completedAtEpoch !== undefined) { sets.push("completed_at_epoch = ?"); values.push(input.completedAtEpoch); }
    if (input.status !== undefined) { sets.push("status = ?"); values.push(input.status); }
    if (input.promptCounter !== undefined) { sets.push("prompt_counter = ?"); values.push(input.promptCounter); }
    if (input.customTitle !== undefined) { sets.push("custom_title = ?"); values.push(input.customTitle); }
    if (input.memorySessionId !== undefined) { sets.push("memory_session_id = ?"); values.push(input.memorySessionId); }

    if (sets.length === 0) return;

    values.push(contentSessionId);
    this.db.prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE content_session_id = ?`).run(...values);
  }

  listSessions(options: ListSessionsOptions = {}): Session[] {
    let query = "SELECT * FROM sessions WHERE 1=1";
    const params: unknown[] = [];

    if (options.project) { query += " AND project = ?"; params.push(options.project); }

    query += " ORDER BY started_at_epoch DESC";
    if (options.limit) { query += " LIMIT ?"; params.push(options.limit); }
    if (options.offset) { query += " OFFSET ?"; params.push(options.offset); }

    const rows = this.db.prepare(query).all(...params) as any[];
    return rows.map(this.rowToSession);
  }

  private rowToSession(row: any): Session {
    return {
      id: row.id,
      contentSessionId: row.content_session_id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      platformSource: row.platform_source,
      userPrompt: row.user_prompt,
      startedAt: row.started_at,
      startedAtEpoch: row.started_at_epoch,
      completedAt: row.completed_at,
      completedAtEpoch: row.completed_at_epoch,
      status: row.status,
      promptCounter: row.prompt_counter,
      customTitle: row.custom_title,
    };
  }
}
