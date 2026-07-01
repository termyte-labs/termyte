import { openDatabase, closeDatabase, defaultDbPath, type DB, type DatabaseContext } from "./connection.js";
import { runMigrations } from "./migrations.js";
import type {
  Memory,
  MemoryLifecycleState,
  MemoryType,
  Observation,
  ObservationLifecycleState,
  ObservationType,
  EventType,
  Session,
  Summary,
  Trace,
  TracePipelineState,
} from "../core/types.js";

export class Store {
  private ctx: DatabaseContext;

  constructor(dbPathOrCtx: string | DatabaseContext = defaultDbPath()) {
    this.ctx = typeof dbPathOrCtx === "string" ? openDatabase(dbPathOrCtx) : dbPathOrCtx;
    runMigrations(this.ctx.db);
  }

  getDB(): DB { return this.ctx.db; }
  getPath(): string { return this.ctx.dbPath; }

  transaction<T>(fn: () => T): T {
    return this.ctx.db.transaction(fn)();
  }

  // ---------- sessions ----------

  upsertSession(session_id: string, project: string, repo_id?: string, workspace_root?: string): Session {
    const now = Date.now();
    this.ctx.db.prepare(`
      INSERT INTO sessions (session_id, project, repo_id, workspace_root, started_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        project = excluded.project,
        repo_id = COALESCE(excluded.repo_id, sessions.repo_id),
        workspace_root = COALESCE(excluded.workspace_root, sessions.workspace_root)
    `).run(session_id, project, repo_id ?? null, workspace_root ?? null, now);
    return this.getSession(session_id)!;
  }

  getSession(session_id: string): Session | null {
    const row = this.ctx.db.prepare(
      `SELECT id, session_id, project, repo_id, workspace_root, started_at, ended_at
       FROM sessions WHERE session_id = ?`
    ).get(session_id) as any;
    if (!row) return null;
    return {
      id: row.id, session_id: row.session_id, project: row.project,
      repo_id: row.repo_id, workspace_root: row.workspace_root,
      started_at: row.started_at, ended_at: row.ended_at,
    };
  }

  endSession(session_id: string): void {
    this.ctx.db.prepare(
      `UPDATE sessions SET ended_at = ? WHERE session_id = ?`
    ).run(Date.now(), session_id);
  }

  getRecentSessions(limit = 20): Session[] {
    const rows = this.ctx.db.prepare(
      `SELECT id, session_id, project, repo_id, workspace_root, started_at, ended_at
       FROM sessions ORDER BY started_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map((row) => ({
      id: row.id, session_id: row.session_id, project: row.project,
      repo_id: row.repo_id, workspace_root: row.workspace_root,
      started_at: row.started_at, ended_at: row.ended_at,
    }));
  }

  // ---------- traces ----------

  insertTrace(trace: Omit<Trace, "id" | "processed_at">): Trace {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO traces (
        session_id, timestamp, event_type, tool_name, tool_input, tool_output,
        files_read, files_modified, user_prompt, final_response
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      trace.session_id, trace.timestamp, trace.event_type,
      trace.tool_name, serialize(trace.tool_input), serialize(trace.tool_output),
      serialize(trace.files_read), serialize(trace.files_modified),
      trace.user_prompt, trace.final_response,
    );
    return { id: info.lastInsertRowid as number, processed_at: null, ...trace };
  }

  getTrace(id: number): Trace | null {
    const row = this.ctx.db.prepare(`SELECT * FROM traces WHERE id = ?`).get(id) as any;
    if (!row) return null;
    return mapTrace(row);
  }

  getTracesForSession(session_id: string, limit = 100): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  getAllTraces(limit = 200): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces ORDER BY timestamp DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapTrace);
  }

  getTracesByIds(ids: number[]): Trace[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces WHERE id IN (${placeholders})`
    ).all(...ids) as any[];
    return rows.map(mapTrace);
  }

  getUnprocessedTraces(limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces WHERE processed_at IS NULL ORDER BY timestamp ASC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapTrace);
  }

  getUnprocessedTracesForSession(session_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces WHERE session_id = ? AND processed_at IS NULL ORDER BY timestamp ASC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  /** Get unprocessed traces from sessions in a particular repo. Used
   *  by the background synthesizer when a user wants to scope
   *  synthesis to a single repo. */
  getUnprocessedTracesByRepo(repo_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT t.* FROM traces t
       INNER JOIN sessions s ON s.session_id = t.session_id
       WHERE t.processed_at IS NULL AND s.repo_id = ?
       ORDER BY t.timestamp ASC LIMIT ?`
    ).all(repo_id, limit) as any[];
    return rows.map(mapTrace);
  }

  markTraceProcessed(traceId: number): void {
    this.ctx.db.prepare(`UPDATE traces SET processed_at = ?, pipeline_state = 'memory_ready' WHERE id = ?`)
      .run(Date.now(), traceId);
  }

  markTracesProcessed(traceIds: number[]): void {
    if (traceIds.length === 0) return;
    const stmt = this.ctx.db.prepare(`UPDATE traces SET processed_at = ?, pipeline_state = 'memory_ready' WHERE id = ?`);
    const tx = this.ctx.db.transaction((ids: number[]) => {
      const now = Date.now();
      for (const id of ids) stmt.run(now, id);
    });
    tx(traceIds);
  }

  updateTracePipelineState(traceId: number, state: TracePipelineState): void {
    this.ctx.db.prepare(`UPDATE traces SET pipeline_state = ? WHERE id = ?`).run(state, traceId);
  }

  markTraceFailed(traceId: number): void {
    this.ctx.db.prepare(`UPDATE traces SET pipeline_state = 'failed' WHERE id = ?`).run(traceId);
  }

  // ---------- observations ----------

  insertObservation(obs: Omit<Observation, "id">): Observation {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO observations (
        session_id, repo_id, workspace_root, type, title, description,
        files_read, files_modified, commands_executed, source_trace_ids,
        created_at, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      obs.session_id, obs.repo_id, obs.workspace_root,
      obs.type, obs.title, obs.description,
      serialize(obs.files_read), serialize(obs.files_modified),
      serialize(obs.commands_executed), serialize(obs.source_trace_ids),
      obs.created_at,
      null,
    );
    return { id: info.lastInsertRowid as number, ...obs };
  }

  getObservation(id: number): Observation | null {
    const row = this.ctx.db.prepare(
      `SELECT * FROM observations WHERE id = ?`
    ).get(id) as any;
    if (!row) return null;
    return mapObservation(row);
  }

  getObservationsForSession(session_id: string, limit = 100): Observation[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM observations WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapObservation);
  }

  getRecentObservations(limit = 100, repo_id?: string): Observation[] {
    if (repo_id) {
      const rows = this.ctx.db.prepare(
        `SELECT * FROM observations WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(repo_id, limit) as any[];
      return rows.map(mapObservation);
    }
    const rows = this.ctx.db.prepare(
      `SELECT * FROM observations ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapObservation);
  }

  getUnprocessedObservations(limit = 50): Observation[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM observations WHERE processed_at IS NULL ORDER BY created_at ASC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapObservation);
  }

  markObservationProcessed(id: number): void {
    this.ctx.db.prepare(`UPDATE observations SET processed_at = ?, lifecycle_state = 'indexed' WHERE id = ?`)
      .run(Date.now(), id);
  }

  markObservationsProcessed(ids: number[]): void {
    if (ids.length === 0) return;
    const stmt = this.ctx.db.prepare(`UPDATE observations SET processed_at = ?, lifecycle_state = 'indexed' WHERE id = ?`);
    const tx = this.ctx.db.transaction((obsIds: number[]) => {
      const now = Date.now();
      for (const id of obsIds) stmt.run(now, id);
    });
    tx(ids);
  }

  updateObservationEmbedding(id: number, embedding: Float32Array): void {
    this.ctx.db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`)
      .run(Buffer.from(embedding.buffer), id);
  }

  updateObservationLifecycleState(id: number, state: ObservationLifecycleState): void {
    this.ctx.db.prepare(`UPDATE observations SET lifecycle_state = ? WHERE id = ?`).run(state, id);
  }

  markObservationFailed(id: number): void {
    this.updateObservationLifecycleState(id, "failed");
  }

  // ---------- memories ----------

  insertMemory(memory: Omit<Memory, "id">): Memory {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO memories (
        session_id, repo_id, workspace_root, type, title, description,
        files_read, files_modified, source_observation_ids, source_trace_ids,
        created_at, embedding
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      memory.session_id, memory.repo_id, memory.workspace_root,
      memory.type, memory.title, memory.description,
      serialize(memory.files_read), serialize(memory.files_modified),
      serialize(memory.source_observation_ids), serialize(memory.source_trace_ids),
      memory.created_at,
      memory.embedding ? Buffer.from(memory.embedding.buffer) : null,
    );
    return { id: info.lastInsertRowid as number, ...memory };
  }

  updateMemoryEmbedding(id: number, embedding: Float32Array): void {
    this.ctx.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`)
      .run(Buffer.from(embedding.buffer), id);
  }

  updateMemoryLifecycleState(id: number, state: MemoryLifecycleState): void {
    const memoryState = ["active", "stale", "superseded", "conflicted", "deleted"].includes(state)
      ? state
      : null;
    this.ctx.db.prepare(`
      UPDATE memories
      SET lifecycle_state = ?, state = COALESCE(?, state)
      WHERE id = ?
    `).run(state, memoryState, id);
  }

  markMemoryFailed(id: number): void {
    this.updateMemoryLifecycleState(id, "failed");
  }

  getMemory(id: number): Memory | null {
    const row = this.ctx.db.prepare(
      `SELECT * FROM memories WHERE id = ?`
    ).get(id) as any;
    if (!row) return null;
    return mapMemory(row);
  }

  getMemoriesForSession(session_id: string, limit = 100): Memory[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM memories WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapMemory);
  }

  getRecentMemories(limit = 100, repo_id?: string): Memory[] {
    if (repo_id) {
      const rows = this.ctx.db.prepare(
        `SELECT * FROM memories WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(repo_id, limit) as any[];
      return rows.map(mapMemory);
    }
    const rows = this.ctx.db.prepare(
      `SELECT * FROM memories ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapMemory);
  }

  getAllMemoriesWithEmbeddings(repo_id?: string): Memory[] {
    if (repo_id) {
      const rows = this.ctx.db.prepare(
        `SELECT * FROM memories WHERE repo_id = ? AND embedding IS NOT NULL`
      ).all(repo_id) as any[];
      return rows.map(mapMemory);
    }
    const rows = this.ctx.db.prepare(
      `SELECT * FROM memories WHERE embedding IS NOT NULL`
    ).all() as any[];
    return rows.map(mapMemory);
  }

  deleteMemory(id: number): void {
    this.ctx.db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
  }

  // ---------- summaries ----------

  upsertSummary(summary: Omit<Summary, "id">): Summary {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO summaries (session_id, repo_id, workspace_root, summary, key_changes, key_learnings, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        workspace_root = excluded.workspace_root,
        summary = excluded.summary,
        key_changes = excluded.key_changes,
        key_learnings = excluded.key_learnings,
        created_at = excluded.created_at
    `);
    stmt.run(
      summary.session_id, summary.repo_id, summary.workspace_root,
      summary.summary, serialize(summary.key_changes ?? []),
      serialize(summary.key_learnings ?? []), summary.created_at,
    );
    return this.getSummary(summary.session_id)!;
  }

  getSummary(session_id: string): Summary | null {
    const row = this.ctx.db.prepare(`SELECT * FROM summaries WHERE session_id = ?`)
      .get(session_id) as any;
    if (!row) return null;
    return mapSummary(row);
  }

  getMostRecentSummaryForRepo(repo_id: string): Summary | null {
    const row = this.ctx.db.prepare(
      `SELECT * FROM summaries WHERE repo_id = ? ORDER BY created_at DESC LIMIT 1`
    ).get(repo_id) as any;
    if (!row) return null;
    return mapSummary(row);
  }

  getAllSummaries(repo_id?: string, limit = 50): Summary[] {
    if (repo_id) {
      const rows = this.ctx.db.prepare(
        `SELECT * FROM summaries WHERE repo_id = ? ORDER BY created_at DESC LIMIT ?`
      ).all(repo_id, limit) as any[];
      return rows.map(mapSummary);
    }
    const rows = this.ctx.db.prepare(
      `SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapSummary);
  }

  // ---------- lifecycle ----------

  close(): void { closeDatabase(this.ctx); }
}

// ---------- helpers ----------

function serialize(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return JSON.stringify(v);
}

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function parseNumberArray(s: string | null | undefined): number[] {
  if (!s) return [];
  try {
    const arr = JSON.parse(s);
    return Array.isArray(arr) ? arr.filter((v: unknown) => typeof v === "number") : [];
  } catch { return []; }
}

function mapTrace(row: any): Trace {
  return {
    id: row.id, session_id: row.session_id, timestamp: row.timestamp,
    event_type: row.event_type as EventType,
    tool_name: row.tool_name,
    tool_input: parseJSON(row.tool_input, null),
    tool_output: parseJSON(row.tool_output, null),
    files_read: parseJSON<string[] | null>(row.files_read, null),
    files_modified: parseJSON<string[] | null>(row.files_modified, null),
    user_prompt: row.user_prompt, final_response: row.final_response,
    processed_at: row.processed_at,
    pipeline_state: row.pipeline_state,
  };
}

function mapObservation(row: any): Observation {
  return {
    id: row.id, session_id: row.session_id,
    repo_id: row.repo_id, workspace_root: row.workspace_root,
    type: row.type as ObservationType,
    title: row.title, description: row.description,
    files_read: parseJSON<string[]>(row.files_read, []),
    files_modified: parseJSON<string[]>(row.files_modified, []),
    commands_executed: parseJSON<string[]>(row.commands_executed, []),
    source_trace_ids: parseNumberArray(row.source_trace_ids),
    created_at: row.created_at, processed_at: row.processed_at,
    lifecycle_state: row.lifecycle_state,
  };
}

function mapMemory(row: any): Memory {
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const buf = row.embedding as Buffer;
    embedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return {
    id: row.id, session_id: row.session_id,
    repo_id: row.repo_id, workspace_root: row.workspace_root,
    type: row.type as MemoryType,
    title: row.title, description: row.description,
    files_read: parseJSON<string[]>(row.files_read, []),
    files_modified: parseJSON<string[]>(row.files_modified, []),
    source_observation_ids: parseNumberArray(row.source_observation_ids),
    source_trace_ids: parseNumberArray(row.source_trace_ids),
    created_at: row.created_at, embedding,
    lifecycle_state: row.lifecycle_state,
    state: row.state,
    importance: row.importance,
    confidence: row.confidence,
    usage_count: row.usage_count,
    last_accessed_at: row.last_accessed_at,
    last_reinforced_at: row.last_reinforced_at,
    decayed_score: row.decayed_score,
    content_hash: row.content_hash,
    canonical_key: row.canonical_key,
    superseded_by: row.superseded_by,
  };
}

function mapSummary(row: any): Summary {
  return {
    id: row.id, session_id: row.session_id,
    repo_id: row.repo_id, workspace_root: row.workspace_root,
    summary: row.summary,
    key_changes: parseJSON<string[] | null>(row.key_changes, null),
    key_learnings: parseJSON<string[] | null>(row.key_learnings, null),
    created_at: row.created_at,
  };
}
