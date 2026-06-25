import { openDatabase, closeDatabase, defaultDbPath, type DB, type DatabaseContext } from "./connection.js";
import { runMigrations } from "./migrations.js";
import type { Memory, MemoryType, Session, Summary, Trace, EventType } from "../core/types.js";

/**
 * The store. All persistence goes through here.
 *
 * Convention: methods that take JSON-shaped fields (tool_input, tool_output,
 * files_read, etc.) accept already-parsed JS values and serialize them at
 * the SQL boundary. Callers never pass strings.
 */
export class Store {
  private ctx: DatabaseContext;

  constructor(dbPathOrCtx: string | DatabaseContext = defaultDbPath()) {
    this.ctx = typeof dbPathOrCtx === "string" ? openDatabase(dbPathOrCtx) : dbPathOrCtx;
    runMigrations(this.ctx.db);
  }

  /** Expose the raw DB for query builders that need to compose their own SQL. */
  getDB(): DB {
    return this.ctx.db;
  }

  getPath(): string {
    return this.ctx.dbPath;
  }

  // ---------- sessions ----------

  upsertSession(session_id: string, project: string): Session {
    const now = Date.now();
    this.ctx.db.prepare(`
      INSERT INTO sessions (session_id, project, started_at) VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET project = excluded.project
    `).run(session_id, project, now);
    return this.getSession(session_id)!;
  }

  getSession(session_id: string): Session | null {
    const row = this.ctx.db.prepare(
      `SELECT id, session_id, project, started_at, ended_at FROM sessions WHERE session_id = ?`
    ).get(session_id) as any;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      project: row.project,
      started_at: row.started_at,
      ended_at: row.ended_at,
    };
  }

  endSession(session_id: string): void {
    this.ctx.db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE session_id = ?`
    ).run(Date.now(), session_id);
  }

  // ---------- traces ----------

  insertTrace(trace: Omit<Trace, "id" | "processed_at">): Trace {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO traces (
        session_id, timestamp, event_type,
        tool_name, tool_input, tool_output,
        files_read, files_modified,
        user_prompt, final_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      trace.session_id,
      trace.timestamp,
      trace.event_type,
      trace.tool_name,
      serialize(trace.tool_input),
      serialize(trace.tool_output),
      serialize(trace.files_read),
      serialize(trace.files_modified),
      trace.user_prompt,
      trace.final_response,
    );
    return {
      id: info.lastInsertRowid as number,
      processed_at: null,
      ...trace,
    };
  }

  getTrace(id: number): Trace | null {
    const row = this.ctx.db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return mapTrace(row);
  }

  getTracesForSession(session_id: string, limit = 100): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT * FROM traces WHERE session_id = ?
      ORDER BY timestamp ASC LIMIT ?
    `).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  /** All traces the observer hasn't yet processed, oldest first. */
  getUnprocessedTraces(limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT * FROM traces WHERE processed_at IS NULL
      ORDER BY timestamp ASC LIMIT ?
    `).all(limit) as any[];
    return rows.map(mapTrace);
  }

  /** Unprocessed traces for one session, oldest first. */
  getUnprocessedTracesForSession(session_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT * FROM traces WHERE session_id = ? AND processed_at IS NULL
      ORDER BY timestamp ASC LIMIT ?
    `).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  markTraceProcessed(traceId: number): void {
    this.ctx.db.prepare(
      `UPDATE traces SET processed_at = ? WHERE id = ?`
    ).run(Date.now(), traceId);
  }

  /** Mark a batch of traces processed in one statement. */
  markTracesProcessed(traceIds: number[]): void {
    if (traceIds.length === 0) return;
    const stmt = this.ctx.db.prepare(
      `UPDATE traces SET processed_at = ? WHERE id = ?`
    );
    const tx = this.ctx.db.transaction((ids: number[]) => {
      const now = Date.now();
      for (const id of ids) stmt.run(now, id);
    });
    tx(traceIds);
  }

  // ---------- memories ----------

  insertMemory(memory: Omit<Memory, "id">): Memory {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO memories (
        session_id, type, title, subtitle,
        facts, narrative, concepts,
        files_read, files_modified,
        created_at, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      memory.session_id,
      memory.type,
      memory.title,
      memory.subtitle,
      serialize(memory.facts),
      memory.narrative,
      serialize(memory.concepts),
      serialize(memory.files_read),
      serialize(memory.files_modified),
      memory.created_at,
      memory.embedding ? Buffer.from(memory.embedding.buffer) : null,
    );
    return { id: info.lastInsertRowid as number, ...memory };
  }

  updateMemoryEmbedding(id: number, embedding: Float32Array): void {
    this.ctx.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`)
      .run(Buffer.from(embedding.buffer), id);
  }

  getMemory(id: number): Memory | null {
    const row = this.ctx.db.prepare(
      `SELECT id, session_id, type, title, subtitle, facts, narrative,
              concepts, files_read, files_modified, created_at, embedding
       FROM memories WHERE id = ?`
    ).get(id) as any;
    if (!row) return null;
    return mapMemory(row);
  }

  getMemoriesForSession(session_id: string, limit = 100): Memory[] {
    const rows = this.ctx.db.prepare(`
      SELECT id, session_id, type, title, subtitle, facts, narrative,
             concepts, files_read, files_modified, created_at, embedding
      FROM memories WHERE session_id = ?
      ORDER BY created_at DESC LIMIT ?
    `).all(session_id, limit) as any[];
    return rows.map(mapMemory);
  }

  getRecentMemories(limit = 100, project?: string): Memory[] {
    if (project) {
      const rows = this.ctx.db.prepare(`
        SELECT m.id, m.session_id, m.type, m.title, m.subtitle, m.facts,
               m.narrative, m.concepts, m.files_read, m.files_modified,
               m.created_at, m.embedding
        FROM memories m
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE s.project = ?
        ORDER BY m.created_at DESC LIMIT ?
      `).all(project, limit) as any[];
      return rows.map(mapMemory);
    }
    const rows = this.ctx.db.prepare(`
      SELECT id, session_id, type, title, subtitle, facts, narrative,
             concepts, files_read, files_modified, created_at, embedding
      FROM memories
      ORDER BY created_at DESC LIMIT ?
    `).all(limit) as any[];
    return rows.map(mapMemory);
  }

  /** All memories that have a non-null embedding. Used by vector search. */
  getAllMemoriesWithEmbeddings(project?: string): Memory[] {
    if (project) {
      const rows = this.ctx.db.prepare(`
        SELECT m.id, m.session_id, m.type, m.title, m.subtitle, m.facts,
               m.narrative, m.concepts, m.files_read, m.files_modified,
               m.created_at, m.embedding
        FROM memories m
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE s.project = ? AND m.embedding IS NOT NULL
      `).all(project) as any[];
      return rows.map(mapMemory);
    }
    const rows = this.ctx.db.prepare(`
      SELECT id, session_id, type, title, subtitle, facts, narrative,
             concepts, files_read, files_modified, created_at, embedding
      FROM memories WHERE embedding IS NOT NULL
    `).all() as any[];
    return rows.map(mapMemory);
  }

  // ---------- summaries ----------

  upsertSummary(summary: Omit<Summary, "id">): Summary {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO summaries (
        session_id, request, investigated, learned,
        completed, next_steps, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        request = excluded.request,
        investigated = excluded.investigated,
        learned = excluded.learned,
        completed = excluded.completed,
        next_steps = excluded.next_steps,
        notes = excluded.notes,
        created_at = excluded.created_at
    `);
    const info = stmt.run(
      summary.session_id,
      summary.request,
      summary.investigated,
      summary.learned,
      summary.completed,
      summary.next_steps,
      summary.notes,
      summary.created_at,
    );
    return { id: info.lastInsertRowid as number, ...summary };
  }

  getSummary(session_id: string): Summary | null {
    const row = this.ctx.db.prepare(
      `SELECT id, session_id, request, investigated, learned,
              completed, next_steps, notes, created_at
       FROM summaries WHERE session_id = ?`
    ).get(session_id) as any;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      notes: row.notes,
      created_at: row.created_at,
    };
  }

  getMostRecentSummaryForProject(project: string): Summary | null {
    const row = this.ctx.db.prepare(`
      SELECT s.id, s.session_id, s.request, s.investigated, s.learned,
             s.completed, s.next_steps, s.notes, s.created_at
      FROM summaries s
      INNER JOIN sessions sess ON sess.session_id = s.session_id
      WHERE sess.project = ?
      ORDER BY s.created_at DESC LIMIT 1
    `).get(project) as any;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      request: row.request,
      investigated: row.investigated,
      learned: row.learned,
      completed: row.completed,
      next_steps: row.next_steps,
      notes: row.notes,
      created_at: row.created_at,
    };
  }

  // ---------- lifecycle ----------

  close(): void {
    closeDatabase(this.ctx);
  }
}

// ---------- helpers ----------

function serialize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function mapTrace(row: any): Trace {
  return {
    id: row.id,
    session_id: row.session_id,
    timestamp: row.timestamp,
    event_type: row.event_type as EventType,
    tool_name: row.tool_name,
    tool_input: parseJSON<unknown>(row.tool_input, null),
    tool_output: parseJSON<unknown>(row.tool_output, null),
    files_read: parseJSON<string[] | null>(row.files_read, null),
    files_modified: parseJSON<string[] | null>(row.files_modified, null),
    user_prompt: row.user_prompt,
    final_response: row.final_response,
    processed_at: row.processed_at,
  };
}

function mapMemory(row: any): Memory {
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const buf = row.embedding as Buffer;
    embedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return {
    id: row.id,
    session_id: row.session_id,
    type: row.type as MemoryType,
    title: row.title,
    subtitle: row.subtitle,
    facts: parseJSON<string[]>(row.facts, []),
    narrative: row.narrative,
    concepts: parseJSON<string[]>(row.concepts, []),
    files_read: parseJSON<string[]>(row.files_read, []),
    files_modified: parseJSON<string[]>(row.files_modified, []),
    created_at: row.created_at,
    embedding,
  };
}
