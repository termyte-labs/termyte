import { randomUUID } from "node:crypto";
import { openDatabase, closeDatabase, defaultDbPath, type DB, type DatabaseContext } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { applyFeedback } from "../lifecycle/feedback.js";
import { MemoryVecIndex, type MemoryVectorHit } from "../indexing/memory-vec-index.js";
import type { RetrievalScoreBreakdown } from "../retrieval/ranking.js";
import { redactTracePayload } from "../security/redaction.js";
import type {
  CodeApplicabilityEvidence,
  ContextCandidate,
  ContextCandidateKind,
  ContextPacket,
  Episode,
  EpisodeOutcome,
  EpisodeStatus,
  Evidence,
  EvidenceKind,
  Memory,
  MemoryFeedbackEvent,
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
  private readonly memoryVecIndexes = new Map<number, MemoryVecIndex>();
  private readonly memoryVecBackfilled = new Set<number>();
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

  recordAudit(operation: string, targetType: string, targetId: string | number, details?: Record<string, unknown>, source?: string): void {
    this.ctx.db.prepare(`
      INSERT INTO audit_log (operation, target_type, target_id, details, source)
      VALUES (?, ?, ?, ?, ?)
    `).run(operation, targetType, String(targetId), details ? JSON.stringify(details) : null, source ?? null);
  }

  getAuditLog(options: { operation?: string; limit?: number; after?: string } = {}): Array<{
    id: number; timestamp: string; operation: string; target_type: string;
    target_id: string; details: string | null; source: string | null;
  }> {
    const where: string[] = [];
    const params: any[] = [];
    if (options.operation) { where.push("operation = ?"); params.push(options.operation); }
    if (options.after) { where.push("timestamp > ?"); params.push(options.after); }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    params.push(options.limit ?? 100);
    return this.ctx.db.prepare(`
      SELECT id, timestamp, operation, target_type, target_id, details, source
      FROM audit_log ${clause}
      ORDER BY timestamp DESC LIMIT ?
    `).all(...params) as any[];
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

  // ---------- episodes and evidence ----------

  startEpisode(input: { sessionId: string; repoId: string; workspaceRoot: string; task: string; baseCommit?: string | null; nowMs?: number }): Episode {
    const nowMs = input.nowMs ?? Date.now();
    this.closeActiveEpisode(input.sessionId, "unknown", nowMs);
    const id = `episode_${randomUUID()}`;
    this.ctx.db.prepare(`
      INSERT INTO episodes (id, session_id, repo_id, workspace_root, task, status, base_commit, started_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, input.sessionId, input.repoId, input.workspaceRoot, input.task, input.baseCommit ?? null, nowMs);
    return this.getEpisode(id)!;
  }

  getEpisode(id: string): Episode | null {
    const row = this.ctx.db.prepare(`SELECT * FROM episodes WHERE id = ?`).get(id) as any;
    return row ? mapEpisode(row) : null;
  }

  getActiveEpisode(sessionId: string): Episode | null {
    const row = this.ctx.db.prepare(`
      SELECT * FROM episodes WHERE session_id = ? AND status = 'active'
      ORDER BY started_at DESC LIMIT 1
    `).get(sessionId) as any;
    return row ? mapEpisode(row) : null;
  }

  getEpisodes(options: { sessionId?: string; repoId?: string; limit?: number } = {}): Episode[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId) { where.push("session_id = ?"); params.push(options.sessionId); }
    if (options.repoId) { where.push("repo_id = ?"); params.push(options.repoId); }
    params.push(options.limit ?? 100);
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return (this.ctx.db.prepare(`SELECT * FROM episodes ${clause} ORDER BY started_at DESC LIMIT ?`).all(...params) as any[]).map(mapEpisode);
  }

  closeActiveEpisode(
    sessionId: string,
    status: Exclude<EpisodeStatus, "active"> = "unknown",
    nowMs = Date.now(),
    finalCommit: string | null = null,
  ): Episode | null {
    const active = this.getActiveEpisode(sessionId);
    if (!active) return null;
    this.ctx.db.prepare(`UPDATE episodes SET status = ?, ended_at = ?, final_commit = ? WHERE id = ? AND status = 'active'`)
      .run(status, nowMs, finalCommit, active.id);
    return this.getEpisode(active.id);
  }

  linkTraceToEpisode(episodeId: string, traceId: number): void {
    this.ctx.db.prepare(`INSERT OR IGNORE INTO episode_traces (episode_id, trace_id) VALUES (?, ?)`)
      .run(episodeId, traceId);
  }

  getEpisodeTraces(episodeId: string): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT t.* FROM traces t JOIN episode_traces et ON et.trace_id = t.id
      WHERE et.episode_id = ? ORDER BY t.timestamp ASC
    `).all(episodeId) as any[];
    return rows.map(mapTrace);
  }

  insertEvidence(input: { episodeId: string; kind: EvidenceKind; content: string; exitCode?: number | null; metadata?: Record<string, unknown>; traceIds?: number[]; observedAt?: number }): Evidence {
    const id = `evidence_${randomUUID()}`;
    const observedAt = input.observedAt ?? Date.now();
    this.transaction(() => {
      this.ctx.db.prepare(`
        INSERT INTO evidence (id, episode_id, kind, content, exit_code, metadata_json, observed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.episodeId, input.kind, input.content, input.exitCode ?? null, serialize(input.metadata ?? {}), observedAt);
      const link = this.ctx.db.prepare(`INSERT OR IGNORE INTO evidence_traces (evidence_id, trace_id) VALUES (?, ?)`);
      for (const traceId of input.traceIds ?? []) link.run(id, traceId);
    });
    return this.getEvidence(id)!;
  }

  getEvidence(id: string): Evidence | null {
    const row = this.ctx.db.prepare(`SELECT * FROM evidence WHERE id = ?`).get(id) as any;
    return row ? mapEvidence(row) : null;
  }

  getEvidenceForEpisode(episodeId: string): Evidence[] {
    return (this.ctx.db.prepare(`SELECT * FROM evidence WHERE episode_id = ? ORDER BY observed_at ASC`).all(episodeId) as any[]).map(mapEvidence);
  }

  getRecentEvidenceForRepo(repoId: string, limit = 50): Evidence[] {
    const rows = this.ctx.db.prepare(`
      SELECT e.*
      FROM evidence e
      JOIN episodes ep ON ep.id = e.episode_id
      WHERE ep.repo_id = ?
      ORDER BY e.observed_at DESC
      LIMIT ?
    `).all(repoId, limit) as any[];
    return rows.map(mapEvidence);
  }

  getEvidenceForEpisodeSupportingTraces(episodeId: string, traceIds: number[]): Evidence[] {
    if (traceIds.length === 0) return [];
    const placeholders = traceIds.map(() => "?").join(", ");
    const rows = this.ctx.db.prepare(`
      SELECT DISTINCT e.*
      FROM evidence e
      LEFT JOIN evidence_traces et ON et.evidence_id = e.id
      WHERE e.episode_id = ?
        AND (e.kind = 'diff' OR et.trace_id IN (${placeholders}))
      ORDER BY e.observed_at ASC
    `).all(episodeId, ...traceIds) as any[];
    return rows.map(mapEvidence);
  }

  linkMemoryEvidence(memoryId: number, evidenceIds: string[]): void {
    const insert = this.ctx.db.prepare(`INSERT OR IGNORE INTO memory_evidence (memory_id, evidence_id) VALUES (?, ?)`);
    for (const evidenceId of [...new Set(evidenceIds)]) insert.run(memoryId, evidenceId);
  }

  getMemoryEvidenceLinks(memoryId: number): Array<{ evidence_id: string; evidence: Evidence | null }> {
    const rows = this.ctx.db.prepare(`
      SELECT me.evidence_id, e.*
      FROM memory_evidence me
      LEFT JOIN evidence e ON e.id = me.evidence_id
      WHERE me.memory_id = ?
      ORDER BY e.observed_at ASC, me.evidence_id ASC
    `).all(memoryId) as any[];
    return rows.map((row) => ({
      evidence_id: row.evidence_id,
      evidence: row.id ? mapEvidence(row) : null,
    }));
  }

  getActiveMemoryProvenanceViolations(): number[] {
    const memories = (this.ctx.db.prepare(`SELECT * FROM memories WHERE lifecycle_state = 'active'`).all() as any[]).map(mapMemory);
    return memories.filter((memory) => {
      const hasObservation = this.getObservationsByIds(memory.source_observation_ids).length > 0;
      const hasTrace = this.getTracesByIds(memory.source_trace_ids).length > 0;
      const hasEvidence = this.getMemoryEvidenceLinks(memory.id).some((link) => link.evidence !== null);
      return !hasObservation && !hasTrace && !hasEvidence;
    }).map((memory) => memory.id);
  }

  recordEpisodeOutcome(input: { episodeId: string; status: EpisodeOutcome["status"]; source: EpisodeOutcome["source"]; notes?: string | null; contextInjectionId?: string | null; nowMs?: number }): EpisodeOutcome {
    if (!this.getEpisode(input.episodeId)) throw new Error(`Episode not found: ${input.episodeId}`);
    const id = `outcome_${randomUUID()}`;
    const nowMs = input.nowMs ?? Date.now();
    this.transaction(() => {
      this.ctx.db.prepare(`
        INSERT INTO episode_outcomes (id, episode_id, status, source, notes, context_injection_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(id, input.episodeId, input.status, input.source, input.notes ?? null, input.contextInjectionId ?? null, nowMs);
      const preferred = this.getCurrentEpisodeOutcome(input.episodeId);
      this.ctx.db.prepare(`UPDATE episodes SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE id = ?`)
        .run(preferred?.status ?? input.status, nowMs, input.episodeId);
    });
    return this.getEpisodeOutcomes(input.episodeId)[0]!;
  }

  getEpisodeOutcomes(episodeId: string): EpisodeOutcome[] {
    return (this.ctx.db.prepare(`SELECT * FROM episode_outcomes WHERE episode_id = ? ORDER BY created_at DESC, rowid DESC`).all(episodeId) as any[]).map(mapEpisodeOutcome);
  }

  getCurrentEpisodeOutcome(episodeId: string): EpisodeOutcome | null {
    const row = this.ctx.db.prepare(`
      SELECT * FROM episode_outcomes
      WHERE episode_id = ?
      ORDER BY CASE WHEN source IN ('human', 'viewer') THEN 0 ELSE 1 END,
               created_at DESC, rowid DESC
      LIMIT 1
    `).get(episodeId) as any;
    return row ? mapEpisodeOutcome(row) : null;
  }

  // ---------- traces ----------

  insertTrace(trace: Omit<Trace, "id" | "processed_at">): Trace {
    const redacted = redactTracePayload({
      tool_input: trace.tool_input,
      tool_output: trace.tool_output,
      user_prompt: trace.user_prompt,
      final_response: trace.final_response,
    });
    const stmt = this.ctx.db.prepare(`
      INSERT INTO traces (
        session_id, timestamp, event_type, tool_name, tool_input, tool_output,
        files_read, files_modified, user_prompt, final_response, redaction_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(
      trace.session_id, trace.timestamp, trace.event_type,
      trace.tool_name, serialize(redacted.value.tool_input), serialize(redacted.value.tool_output),
      serialize(trace.files_read), serialize(trace.files_modified),
      redacted.value.user_prompt, redacted.value.final_response,
      serialize(redacted.redaction),
    );
    return {
      id: info.lastInsertRowid as number,
      processed_at: null,
      ...trace,
      tool_input: redacted.value.tool_input,
      tool_output: redacted.value.tool_output,
      user_prompt: redacted.value.user_prompt,
      final_response: redacted.value.final_response,
      redaction: redacted.redaction,
    };
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

  getCapturedTraces(limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces
       WHERE processed_at IS NULL AND COALESCE(pipeline_state, 'captured') = 'captured'
       ORDER BY timestamp ASC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(mapTrace);
  }

  getUnprocessedTracesForSession(session_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces WHERE session_id = ? AND processed_at IS NULL ORDER BY timestamp ASC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  getCapturedTracesForSession(session_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM traces
       WHERE session_id = ? AND processed_at IS NULL
         AND COALESCE(pipeline_state, 'captured') = 'captured'
       ORDER BY timestamp ASC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapTrace);
  }

  getCapturedTracesForEpisode(episodeId: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT t.* FROM traces t
      JOIN episode_traces et ON et.trace_id = t.id
      WHERE et.episode_id = ? AND t.processed_at IS NULL
        AND COALESCE(t.pipeline_state, 'captured') = 'captured'
      ORDER BY t.timestamp ASC LIMIT ?
    `).all(episodeId, limit) as any[];
    return rows.map(mapTrace);
  }

  getEpisodeIdsWithCapturedTraces(limit = 50): string[] {
    const rows = this.ctx.db.prepare(`
      SELECT DISTINCT et.episode_id FROM episode_traces et
      JOIN traces t ON t.id = et.trace_id
      WHERE t.processed_at IS NULL AND COALESCE(t.pipeline_state, 'captured') = 'captured'
      ORDER BY t.timestamp ASC LIMIT ?
    `).all(limit) as Array<{ episode_id: string }>;
    return rows.map((row) => row.episode_id);
  }

  getCapturedTracesWithoutEpisode(limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(`
      SELECT t.* FROM traces t
      LEFT JOIN episode_traces et ON et.trace_id = t.id
      WHERE et.trace_id IS NULL AND t.processed_at IS NULL
        AND COALESCE(t.pipeline_state, 'captured') = 'captured'
      ORDER BY t.timestamp ASC LIMIT ?
    `).all(limit) as any[];
    return rows.map(mapTrace);
  }

  getEpisodeIdForTrace(traceId: number): string | null {
    const row = this.ctx.db.prepare(
      `SELECT episode_id FROM episode_traces WHERE trace_id = ? LIMIT 1`,
    ).get(traceId) as { episode_id: string } | undefined;
    return row?.episode_id ?? null;
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

  getCapturedTracesByRepo(repo_id: string, limit = 50): Trace[] {
    const rows = this.ctx.db.prepare(
      `SELECT t.* FROM traces t
       INNER JOIN sessions s ON s.session_id = t.session_id
       WHERE t.processed_at IS NULL AND s.repo_id = ?
         AND COALESCE(t.pipeline_state, 'captured') = 'captured'
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

  getObservationsByIds(ids: number[]): Observation[] {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.ctx.db.prepare(
      `SELECT * FROM observations WHERE id IN (${placeholders})`,
    ).all(...uniqueIds) as any[];
    const byId = new Map(rows.map((row) => {
      const observation = mapObservation(row);
      return [observation.id, observation] as const;
    }));
    return uniqueIds.flatMap((id) => {
      const observation = byId.get(id);
      return observation ? [observation] : [];
    });
  }

  getObservationsForSession(session_id: string, limit = 100): Observation[] {
    const rows = this.ctx.db.prepare(
      `SELECT * FROM observations WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(session_id, limit) as any[];
    return rows.map(mapObservation);
  }

  getObservationsForEpisode(episodeId: string): Observation[] {
    const rows = this.ctx.db.prepare(`
      SELECT DISTINCT o.* FROM observations o
      JOIN trace_observations ot ON ot.observation_id = o.id
      JOIN episode_traces et ON et.trace_id = ot.trace_id
      WHERE et.episode_id = ? AND o.processed_at IS NULL
      ORDER BY o.created_at ASC, o.id ASC
    `).all(episodeId) as any[];
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

  /** Mark a memory's observation complete only after every derived memory is
   *  active. Bounded by the observation's memory fan-out via the indexed
   *  observation_memories link table. */
  markObservationProcessedIfMemoriesReady(id: number): boolean {
    const memIds = this.ctx.db
      .prepare(`SELECT memory_id FROM observation_memories WHERE observation_id = ?`)
      .all(id) as Array<{ memory_id: number }>;
    if (memIds.length === 0) return false;
    const rows = this.ctx.db
      .prepare(`SELECT lifecycle_state FROM memories WHERE id IN (${memIds.map(() => "?").join(",")})`)
      .all(...memIds.map((m) => m.memory_id)) as Array<{ lifecycle_state: string }>;
    if (rows.length === 0 || rows.some((row) => row.lifecycle_state !== "active")) return false;
    this.markObservationProcessed(id);
    return true;
  }

  /** Mark a trace complete only after every derived observation is complete.
   *  Bounded by the trace's observation fan-out via the indexed
   *  trace_observations link table. */
  markTraceProcessedIfObservationsReady(traceId: number): boolean {
    const obsIds = this.ctx.db
      .prepare(`SELECT observation_id FROM trace_observations WHERE trace_id = ?`)
      .all(traceId) as Array<{ observation_id: number }>;
    if (obsIds.length === 0) return false;
    const rows = this.ctx.db
      .prepare(`SELECT processed_at FROM observations WHERE id IN (${obsIds.map(() => "?").join(",")})`)
      .all(...obsIds.map((o) => o.observation_id)) as Array<{ processed_at: number | null }>;
    if (rows.length === 0 || rows.some((row) => row.processed_at === null)) return false;
    this.markTraceProcessed(traceId);
    return true;
  }

  updateObservationEmbedding(id: number, embedding: Float32Array): void {
    this.ctx.db.prepare(`UPDATE observations SET embedding = ? WHERE id = ?`)
      .run(toEmbeddingBuffer(embedding), id);
  }

  updateObservationLifecycleState(id: number, state: ObservationLifecycleState): void {
    this.ctx.db.prepare(`UPDATE observations SET lifecycle_state = ? WHERE id = ?`).run(state, id);
  }

  markObservationFailed(id: number): void {
    this.updateObservationLifecycleState(id, "failed");
  }

  /** Record indexed trace→observation provenance links (idempotent). */
  insertTraceObservationLinks(observationId: number, traceIds: number[]): void {
    if (traceIds.length === 0) return;
    const stmt = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO trace_observations (trace_id, observation_id) VALUES (?, ?)`,
    );
    for (const tid of traceIds) stmt.run(tid, observationId);
  }

  /** Record indexed observation→memory provenance links (idempotent). */
  insertObservationMemoryLinks(memoryId: number, observationIds: number[]): void {
    if (observationIds.length === 0) return;
    const stmt = this.ctx.db.prepare(
      `INSERT OR IGNORE INTO observation_memories (observation_id, memory_id) VALUES (?, ?)`,
    );
    for (const oid of observationIds) stmt.run(oid, memoryId);
  }

  // ---------- memories ----------

  insertMemory(memory: Omit<Memory, "id">): Memory {
    const stmt = this.ctx.db.prepare(`
      INSERT INTO memories (
        session_id, repo_id, workspace_root, type, title, description,
        files_read, files_modified, source_observation_ids, source_trace_ids,
        created_at, embedding, applicability_json, lifecycle_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    `);
    const info = stmt.run(
      memory.session_id, memory.repo_id, memory.workspace_root,
      memory.type, memory.title, memory.description,
      serialize(memory.files_read), serialize(memory.files_modified),
      serialize(memory.source_observation_ids), serialize(memory.source_trace_ids),
      memory.created_at,
      memory.embedding ? toEmbeddingBuffer(memory.embedding) : null,
      serializeApplicabilityEvidence(memory.applicability_evidence),
    );
    const inserted: Memory = { id: info.lastInsertRowid as number, ...memory, lifecycle_state: "active" };
    if (memory.embedding) this.upsertMemoryVector(inserted.id, memory.embedding);
    return inserted;
  }

  updateMemoryEmbedding(id: number, embedding: Float32Array): void {
    this.ctx.db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`)
      .run(toEmbeddingBuffer(embedding), id);
    this.upsertMemoryVector(id, embedding);
  }

  /** Search sqlite-vec when available. Returns null to request scan fallback. */
  searchMemoryVectorIndex(query: Float32Array, limit: number): MemoryVectorHit[] | null {
    const index = this.memoryVectorIndex(query.length);
    if (!index) return null;
    try {
      if (!this.memoryVecBackfilled.has(query.length)) {
        for (const memory of this.getAllMemoriesWithEmbeddings()) {
          if (memory.embedding?.length === query.length) index.upsert(memory.id, memory.embedding);
        }
        this.memoryVecBackfilled.add(query.length);
      }
      return index.search(query, limit);
    } catch {
      // A native extension failure must not remove local vector retrieval.
      // Returning null tells VectorSearch to use its cosine-scan fallback.
      this.memoryVecIndexes.delete(query.length);
      this.memoryVecBackfilled.delete(query.length);
      return null;
    }
  }

  isMemoryVectorIndexAvailable(dimensions: number): boolean {
    return this.memoryVectorIndex(dimensions) !== null;
  }

  private upsertMemoryVector(id: number, embedding: Float32Array): void {
    const index = this.memoryVectorIndex(embedding.length);
    if (!index) return;
    try {
      index.upsert(id, embedding);
    } catch {
      // The embedding BLOB remains authoritative and VectorSearch can scan it.
      this.memoryVecIndexes.delete(embedding.length);
      this.memoryVecBackfilled.delete(embedding.length);
    }
  }

  private memoryVectorIndex(dimensions: number): MemoryVecIndex | null {
    const existing = this.memoryVecIndexes.get(dimensions);
    if (existing) return existing.isAvailable() ? existing : null;
    const index = new MemoryVecIndex(this.ctx.db, dimensions);
    this.memoryVecIndexes.set(dimensions, index);
    return index.ensureSchema() ? index : null;
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

  /** Persist a computed decay score. */
  updateMemoryDecayScore(id: number, decayedScore: number, _nowMs = Date.now()): void {
    this.ctx.db
      .prepare(`UPDATE memories SET decayed_score = ? WHERE id = ?`)
      .run(decayedScore, id);
  }

  /** Reinforce a memory: increment usage, update access/reinforcement
   *  timestamps, and restore from `stale` to `active`. Idempotent for
   *  already-active memories. */
  reinforceMemory(id: number, nowMs = Date.now()): void {
    this.ctx.db
      .prepare(`
        UPDATE memories
        SET usage_count = usage_count + 1,
            last_accessed_at = ?,
            last_reinforced_at = ?,
            lifecycle_state = CASE WHEN lifecycle_state = 'stale' THEN 'active' ELSE lifecycle_state END,
            state = CASE WHEN state = 'stale' THEN 'active' ELSE state END
        WHERE id = ?
      `)
      .run(nowMs, nowMs, id);
  }

  /** Persist the deterministic deduplication key for a memory. */
  updateMemoryCanonicalKey(id: number, canonicalKey: string): void {
    this.ctx.db.prepare(`UPDATE memories SET canonical_key = ? WHERE id = ?`).run(canonicalKey, id);
  }

  // ---------- context injections ----------

  recordContextPacket(input: {
    id?: string;
    sessionId?: string | null;
    episodeId?: string | null;
    repoId: string;
    agent: string;
    task: string;
    tokenBudget: number;
    estimatedTokens: number;
    retrievalMode: string;
    latencyMs: number;
    renderedText: string;
    candidates: Array<{
      candidateId: string;
      kind: ContextCandidateKind;
      sourceId?: string | null;
      tokenEstimate: number;
      selected: boolean;
      rank?: number | null;
      finalScore: number;
      scoreBreakdown?: Record<string, unknown>;
      rejectionReason?: string | null;
      renderedText: string;
    }>;
    nowMs?: number;
  }): ContextPacket {
    const id = input.id ?? `packet_${randomUUID()}`;
    const nowMs = input.nowMs ?? Date.now();
    this.transaction(() => {
      this.ctx.db.prepare(`
        INSERT INTO context_packets (
          id, session_id, episode_id, repo_id, agent, task, token_budget,
          estimated_tokens, retrieval_mode, latency_ms, rendered_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, input.sessionId ?? null, input.episodeId ?? null, input.repoId,
        input.agent, input.task, input.tokenBudget, input.estimatedTokens,
        input.retrievalMode, input.latencyMs, input.renderedText, nowMs,
      );
      const insert = this.ctx.db.prepare(`
        INSERT INTO context_candidates (
          packet_id, candidate_id, kind, source_id, token_estimate, selected,
          rank, final_score, score_breakdown_json, rejection_reason, rendered_text
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const candidate of input.candidates) {
        insert.run(
          id, candidate.candidateId, candidate.kind, candidate.sourceId ?? null,
          candidate.tokenEstimate, candidate.selected ? 1 : 0, candidate.rank ?? null,
          candidate.finalScore, serialize(candidate.scoreBreakdown ?? {}),
          candidate.rejectionReason ?? null, candidate.renderedText,
        );
      }
    });
    return this.getContextPacket(id)!;
  }

  getContextPacket(id: string): ContextPacket | null {
    const row = this.ctx.db.prepare(`SELECT * FROM context_packets WHERE id = ?`).get(id) as any;
    return row ? mapContextPacket(row) : null;
  }

  getContextPackets(options: { sessionId?: string; repoId?: string; episodeId?: string; limit?: number } = {}): ContextPacket[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.sessionId) { where.push("session_id = ?"); params.push(options.sessionId); }
    if (options.repoId) { where.push("repo_id = ?"); params.push(options.repoId); }
    if (options.episodeId) { where.push("episode_id = ?"); params.push(options.episodeId); }
    params.push(options.limit ?? 100);
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return (this.ctx.db.prepare(`SELECT * FROM context_packets ${clause} ORDER BY created_at DESC LIMIT ?`).all(...params) as any[])
      .map(mapContextPacket);
  }

  getContextCandidates(packetId: string): ContextCandidate[] {
    return (this.ctx.db.prepare(`
      SELECT * FROM context_candidates WHERE packet_id = ?
      ORDER BY selected DESC, rank ASC, final_score DESC
    `).all(packetId) as any[]).map(mapContextCandidate);
  }

  /** Record a context injection so downstream outcomes can be attributed. */
  recordContextInjection(input: {
    id: string;
    sessionId?: string;
    repoId?: string;
    query?: string;
    files?: string[];
    memoryIds: number[];
    items?: Array<{
      memoryId: number;
      rank: number;
      score: number;
      ftsRank?: number;
      vectorRank?: number;
      scoreBreakdown?: RetrievalScoreBreakdown;
      renderedText: string;
    }>;
    surface: string;
    packetId?: string;
    deliveryMethod?: string;
    nowMs?: number;
  }): void {
    const nowMs = input.nowMs ?? Date.now();
    this.transaction(() => {
      this.ctx.db.prepare(
        `INSERT OR REPLACE INTO context_injections
           (id, session_id, repo_id, query, files_json, memory_ids_json, surface, packet_id, delivery_method, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        input.id,
        input.sessionId ?? null,
        input.repoId ?? null,
        input.query ?? null,
        serialize(input.files ?? []),
        serialize(input.memoryIds),
        input.surface,
        input.packetId ?? null,
        input.deliveryMethod ?? "unknown",
        nowMs,
      );
      const insertItem = this.ctx.db.prepare(`
        INSERT OR REPLACE INTO context_injection_items
          (injection_id, memory_id, rank, score, fts_rank, vector_rank, score_breakdown_json, rendered_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of input.items ?? []) {
        insertItem.run(
          input.id,
          item.memoryId,
          item.rank,
          item.score,
          item.ftsRank ?? null,
          item.vectorRank ?? null,
          serialize(item.scoreBreakdown ?? {}),
          item.renderedText,
        );
      }
    });
  }

  getContextInjectionItems(injectionId: string): Array<{
    memory_id: number;
    rank: number;
    score: number;
    fts_rank: number | null;
    vector_rank: number | null;
    score_breakdown: Record<string, number>;
    rendered_text: string;
  }> {
    const rows = this.ctx.db.prepare(`
      SELECT memory_id, rank, score, fts_rank, vector_rank, score_breakdown_json, rendered_text
      FROM context_injection_items
      WHERE injection_id = ?
      ORDER BY rank ASC
    `).all(injectionId) as Array<{
      memory_id: number;
      rank: number;
      score: number;
      fts_rank: number | null;
      vector_rank: number | null;
      score_breakdown_json: string;
      rendered_text: string;
    }>;
    return rows.map((row) => ({
      memory_id: row.memory_id,
      rank: row.rank,
      score: row.score,
      fts_rank: row.fts_rank,
      vector_rank: row.vector_rank,
      score_breakdown: parseJSON<Record<string, number>>(row.score_breakdown_json, {}),
      rendered_text: row.rendered_text,
    }));
  }

  /** Retrieve a context injection by ID. */
  getContextInjection(id: string): {
    id: string;
    session_id: string | null;
    repo_id: string | null;
    query: string | null;
    files: string[];
    memory_ids: number[];
    surface: string;
    packet_id: string | null;
    delivery_method: string;
    created_at: number;
  } | null {
    const row = this.ctx.db
      .prepare(`SELECT * FROM context_injections WHERE id = ?`)
      .get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      session_id: row.session_id,
      repo_id: row.repo_id,
      query: row.query,
      files: parseJSON<string[]>(row.files_json, []),
      memory_ids: parseJSON<number[]>(row.memory_ids_json, []),
      surface: row.surface,
      packet_id: row.packet_id,
      delivery_method: row.delivery_method,
      created_at: row.created_at,
    };
  }

  getLatestContextInjectionForEpisode(episodeId: string): ReturnType<Store["getContextInjection"]> {
    const row = this.ctx.db.prepare(`
      SELECT ci.id
      FROM context_injections ci
      JOIN context_packets cp ON cp.id = ci.packet_id
      WHERE cp.episode_id = ?
      ORDER BY ci.created_at DESC, ci.rowid DESC
      LIMIT 1
    `).get(episodeId) as { id: string } | undefined;
    return row ? this.getContextInjection(row.id) : null;
  }

  getEpisodeIdForContextInjection(injectionId: string): string | null {
    const row = this.ctx.db.prepare(`
      SELECT cp.episode_id
      FROM context_injections ci
      JOIN context_packets cp ON cp.id = ci.packet_id
      WHERE ci.id = ?
    `).get(injectionId) as { episode_id: string | null } | undefined;
    return row?.episode_id ?? null;
  }

  getContextInjectionsForEpisode(episodeId: string): NonNullable<ReturnType<Store["getContextInjection"]>>[] {
    const rows = this.ctx.db.prepare(`
      SELECT ci.id
      FROM context_injections ci
      JOIN context_packets cp ON cp.id = ci.packet_id
      WHERE cp.episode_id = ?
      ORDER BY ci.created_at DESC, ci.rowid DESC
    `).all(episodeId) as Array<{ id: string }>;
    return rows.flatMap((row) => {
      const injection = this.getContextInjection(row.id);
      return injection ? [injection] : [];
    });
  }

  /** Mark a memory superseded by `supersededBy`, locking it out of default
   *  retrieval (enforced once lifecycle filtering is wired). */
  markMemorySuperseded(id: number, supersededBy: number): void {
    this.ctx.db
      .prepare(`UPDATE memories SET lifecycle_state = 'superseded', state = 'superseded', superseded_by = ? WHERE id = ?`)
      .run(supersededBy, id);
    this.recordAudit("supersede_memory", "memory", id, { supersededBy }, "pipeline");
  }

  /** Insert a relationship edge between two memories. Idempotent on
   *  (source, target, edge_type) via the schema's UNIQUE constraint. */
  insertMemoryEdge(input: {
    source: number;
    target: number;
    edgeType: "supports" | "contradicts" | "supersedes" | "duplicates" | "derived_from" | "related_to";
    confidence?: number;
    nowMs?: number;
  }): void {
    const nowMs = input.nowMs ?? Date.now();
    this.ctx.db
      .prepare(
        `INSERT OR IGNORE INTO memory_edges (id, source_memory_id, target_memory_id, edge_type, confidence, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), input.source, input.target, input.edgeType, input.confidence ?? 0.9, nowMs);
  }

  /** Read relationship edges involving a memory (as source or target). */
  getMemoryEdges(memoryId: number): Array<{
    id: string;
    source_memory_id: number;
    target_memory_id: number;
    edge_type: string;
    confidence: number;
    created_at: number;
  }> {
    return this.ctx.db
      .prepare(
        `SELECT * FROM memory_edges WHERE source_memory_id = ? OR target_memory_id = ? ORDER BY created_at ASC`,
      )
      .all(memoryId, memoryId) as Array<{
      id: string;
      source_memory_id: number;
      target_memory_id: number;
      edge_type: string;
      confidence: number;
      created_at: number;
    }>;
  }

  /** Read explicit feedback attached to a memory. */
  getMemoryFeedbackForMemory(memoryId: number): Array<{
    id: string;
    memory_id: number;
    doc_id: string | null;
    event_type: MemoryFeedbackEvent;
    weight: number;
    source: string;
    context_injection_id: string | null;
    correction_text: string | null;
    created_at: number;
  }> {
    return this.ctx.db.prepare(`
      SELECT id, memory_id, doc_id, event_type, weight, source,
             context_injection_id, correction_text, created_at
      FROM memory_feedback
      WHERE memory_id = ?
      ORDER BY created_at ASC
    `).all(memoryId) as Array<{
      id: string;
      memory_id: number;
      doc_id: string | null;
      event_type: MemoryFeedbackEvent;
      weight: number;
      source: string;
      context_injection_id: string | null;
      correction_text: string | null;
      created_at: number;
    }>;
  }

  recordMemoryFeedback(input: {
    id: string;
    event: MemoryFeedbackEvent;
    contextInjectionId?: string;
    source?: string;
    correctionText?: string;
    nowMs?: number;
  }): { recorded: boolean; memoryId?: number; reason?: string } {
    const memoryId = this.resolveMemoryId(input.id);
    if (memoryId === null) {
      return { recorded: false, reason: `No memory document found for ${input.id}` };
    }

    const memory = this.getMemory(memoryId);
    if (!memory) {
      return { recorded: false, reason: `Memory ${memoryId} not found` };
    }

    const nowMs = input.nowMs ?? Date.now();
    const next = applyFeedback({
      state: memory.state ?? "active",
      importance: memory.importance ?? 0.5,
      confidence: memory.confidence ?? 0.5,
      usage_count: memory.usage_count ?? 0,
      last_accessed_at: memory.last_accessed_at ?? null,
      last_reinforced_at: memory.last_reinforced_at ?? null,
    }, input.event, nowMs);

    this.transaction(() => {
      if (input.event === "corrected" && input.correctionText && input.contextInjectionId) {
        const episodeId = this.getEpisodeIdForContextInjection(input.contextInjectionId);
        if (episodeId) {
          this.insertEvidence({
            episodeId,
            kind: "human_feedback",
            content: input.correctionText,
            metadata: {
              memory_id: memoryId,
              context_injection_id: input.contextInjectionId,
              source: input.source ?? "mcp",
            },
            observedAt: nowMs,
          });
        }
      }
      this.ctx.db.prepare(`
        INSERT INTO memory_feedback (
          id, memory_id, doc_id, event_type, weight, source,
          context_injection_id, correction_text, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `feedback_${randomUUID()}`,
        memoryId,
        input.id,
        input.event,
        next.weight,
        input.source ?? "mcp",
        input.contextInjectionId ?? null,
        input.correctionText ?? null,
        nowMs,
      );

      this.ctx.db.prepare(`
        UPDATE memories
        SET
          state = ?,
          lifecycle_state = CASE WHEN ? IN ('harmful', 'corrected') THEN 'conflicted' ELSE lifecycle_state END,
          importance = ?,
          confidence = ?,
          usage_count = ?,
          last_accessed_at = ?,
          last_reinforced_at = ?
        WHERE id = ?
      `).run(
        next.state,
        input.event,
        next.importance,
        next.confidence,
        next.usage_count,
        next.last_accessed_at ?? null,
        next.last_reinforced_at ?? null,
        memoryId,
      );

      this.ctx.db.prepare(`
        UPDATE documents
        SET importance = ?, confidence = ?, updated_at = ?
        WHERE id = ?
      `).run(next.importance, next.confidence, nowMs, `memory:${memoryId}`);

      // Enqueue a verification job when a correction is recorded so the
      // pipeline can create a grounded replacement and supersede the old memory.
      if (input.event === "corrected") {
        this.ctx.db.prepare(`
          INSERT OR IGNORE INTO jobs (id, kind, subject_type, subject_id, state, attempt_count, max_attempts, next_run_at, created_at, updated_at)
          VALUES (?, 'verify_memory', 'memory', ?, 'pending', 0, 5, ?, ?, ?)
        `).run(`verify_${randomUUID()}`, String(memoryId), nowMs, nowMs, nowMs);
      }
    });

    return { recorded: true, memoryId };
  }

  /** Aggregate explicit behavioral feedback for bounded query-time ranking.
   * Automatic `shown` events are excluded to prevent exposure feedback loops. */
  getMemoryFeedbackScores(memoryIds: number[]): Map<number, number> {
    if (memoryIds.length === 0) return new Map();
    const placeholders = memoryIds.map(() => "?").join(",");
    const rows = this.ctx.db.prepare(`
      SELECT memory_id, SUM(weight) AS score
      FROM memory_feedback
      WHERE memory_id IN (${placeholders}) AND event_type <> 'shown'
      GROUP BY memory_id
    `).all(...memoryIds) as Array<{ memory_id: number; score: number }>;
    return new Map(rows.map((row) => [row.memory_id, Math.max(-1, Math.min(1, row.score))]));
  }

  /** List dead-lettered jobs with their error details. */
  getDeadJobs(limit = 50): Array<{
    id: string; kind: string; subject_type: string; subject_id: string;
    attempt_count: number; last_error: string | null; updated_at: number;
  }> {
    return this.ctx.db.prepare(`
      SELECT id, kind, subject_type, subject_id, attempt_count, last_error, updated_at
      FROM jobs WHERE state = 'dead' ORDER BY updated_at DESC LIMIT ?
    `).all(limit) as any[];
  }

  /** Retry a dead-lettered job by resetting it to pending. Returns false if the
   *  job doesn't exist or isn't dead. */
  retryDeadJob(jobId: string): boolean {
    const result = this.ctx.db.prepare(`
      UPDATE jobs
      SET state = 'pending', attempt_count = 0, next_run_at = ?,
          last_error = NULL, updated_at = ?
      WHERE id = ? AND state = 'dead'
    `).run(Date.now(), Date.now(), jobId);
    if (result.changes > 0) {
      this.recordAudit("retry_dead_job", "job", jobId, {}, "cli");
    }
    return result.changes > 0;
  }

  /** Dismiss (permanently remove) a dead-lettered job. Returns false if the
   *  job doesn't exist or isn't dead. */
  dismissDeadJob(jobId: string): boolean {
    const result = this.ctx.db.prepare(
      `DELETE FROM jobs WHERE id = ? AND state = 'dead'`,
    ).run(jobId);
    if (result.changes > 0) {
      this.recordAudit("dismiss_dead_job", "job", jobId, {}, "cli");
    }
    return result.changes > 0;
  }

  /** Get health diagnostics: queue stats, oldest pending age, dead count. */
  getHealthDiagnostics(): {
    queue: { pending: number; leased: number; succeeded: number; failed: number; dead: number; ready: number; oldestReadyAgeMs: number | null; completedLastMinute: number; retries: number };
    oldestPendingAgeMs: number | null;
    deadJobs: number;
  } {
    const nowMs = Date.now();
    const stats = this.ctx.db.prepare(`
      SELECT
        SUM(CASE WHEN state='pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN state='leased' THEN 1 ELSE 0 END) AS leased,
        SUM(CASE WHEN state='succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN state='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN state='dead' THEN 1 ELSE 0 END) AS dead
      FROM jobs
    `).get() as { pending: number; leased: number; succeeded: number; failed: number; dead: number };

    const timing = this.ctx.db.prepare(`
      SELECT
        MIN(CASE WHEN state IN ('pending','failed') THEN next_run_at END) AS oldest,
        MIN(CASE WHEN state IN ('pending','failed') AND next_run_at <= @nowMs THEN next_run_at END) AS oldest_ready,
        SUM(CASE WHEN state IN ('pending','failed') AND next_run_at <= @nowMs THEN 1 ELSE 0 END) AS ready,
        SUM(CASE WHEN state='succeeded' AND updated_at >= @minuteAgo THEN 1 ELSE 0 END) AS completed_last_minute
      FROM jobs
    `).get({ nowMs, minuteAgo: nowMs - 60_000 }) as {
      oldest: number | null; oldest_ready: number | null; ready: number; completed_last_minute: number;
    };
    const retryRow = this.ctx.db.prepare(`
      SELECT COALESCE(SUM(CASE WHEN attempt_count > 1 THEN attempt_count - 1 ELSE 0 END), 0) AS retries
      FROM jobs
    `).get() as { retries: number };

    return {
      queue: {
        pending: stats.pending ?? 0,
        leased: stats.leased ?? 0,
        succeeded: stats.succeeded ?? 0,
        failed: stats.failed ?? 0,
        dead: stats.dead ?? 0,
        ready: timing.ready ?? 0,
        oldestReadyAgeMs: timing.oldest_ready == null ? null : Math.max(0, nowMs - timing.oldest_ready),
        completedLastMinute: timing.completed_last_minute ?? 0,
        retries: retryRow.retries ?? 0,
      },
      oldestPendingAgeMs: timing.oldest != null ? Math.max(0, nowMs - timing.oldest) : null,
      deadJobs: stats.dead ?? 0,
    };
  }

  private resolveMemoryId(id: string): number | null {
    const direct = id.match(/^(?:memory:)?(\d+)$/);
    if (direct) return Number(direct[1]);

    const document = this.ctx.db.prepare(`
      SELECT source_id
      FROM documents
      WHERE id = ? AND doc_type = 'memory'
    `).get(id) as { source_id?: string } | undefined;

    if (!document?.source_id || !/^\d+$/.test(document.source_id)) return null;
    return Number(document.source_id);
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

function mapEpisode(row: any): Episode {
  return {
    id: row.id, session_id: row.session_id, repo_id: row.repo_id,
    workspace_root: row.workspace_root, task: row.task, status: row.status,
    base_commit: row.base_commit, final_commit: row.final_commit,
    started_at: row.started_at, ended_at: row.ended_at,
  };
}

function mapEvidence(row: any): Evidence {
  return {
    id: row.id, episode_id: row.episode_id, kind: row.kind,
    content: row.content, exit_code: row.exit_code,
    metadata: parseJSON<Record<string, unknown>>(row.metadata_json, {}),
    observed_at: row.observed_at,
  };
}

function mapEpisodeOutcome(row: any): EpisodeOutcome {
  return {
    id: row.id, episode_id: row.episode_id, status: row.status,
    source: row.source, notes: row.notes,
    context_injection_id: row.context_injection_id, created_at: row.created_at,
  };
}

function mapContextPacket(row: any): ContextPacket {
  return {
    id: row.id, session_id: row.session_id, episode_id: row.episode_id,
    repo_id: row.repo_id, agent: row.agent, task: row.task,
    token_budget: row.token_budget, estimated_tokens: row.estimated_tokens,
    retrieval_mode: row.retrieval_mode, latency_ms: row.latency_ms,
    rendered_text: row.rendered_text, created_at: row.created_at,
  };
}

function mapContextCandidate(row: any): ContextCandidate {
  return {
    packet_id: row.packet_id, candidate_id: row.candidate_id, kind: row.kind,
    source_id: row.source_id, token_estimate: row.token_estimate,
    selected: row.selected === 1, rank: row.rank, final_score: row.final_score,
    score_breakdown: parseJSON<Record<string, unknown>>(row.score_breakdown_json, {}),
    rejection_reason: row.rejection_reason, rendered_text: row.rendered_text,
  };
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
    redaction: parseJSON(row.redaction_json, null),
    processed_at: row.processed_at,
    pipeline_state: row.pipeline_state,
  };
}

function toEmbeddingBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
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
    applicability_evidence: parseApplicabilityEvidence(row.applicability_json),
  };
}

function serializeApplicabilityEvidence(value: CodeApplicabilityEvidence | null | undefined): string {
  const normalized = normalizeApplicabilityEvidence(value);
  return JSON.stringify(normalized);
}

function parseApplicabilityEvidence(raw: string | null | undefined): CodeApplicabilityEvidence | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CodeApplicabilityEvidence>;
    return normalizeApplicabilityEvidence(parsed);
  } catch {
    return null;
  }
}

function normalizeApplicabilityEvidence(
  value: Partial<CodeApplicabilityEvidence> | null | undefined,
): CodeApplicabilityEvidence {
  const files = uniqueStrings(value?.files ?? []);
  const commands = uniqueStrings(value?.commands ?? []);
  const trace_ids = uniqueNumbers(value?.trace_ids ?? []);
  const observation_ids = uniqueNumbers(value?.observation_ids ?? []);
  return { files, commands, trace_ids, observation_ids };
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function uniqueNumbers(values: unknown[]): number[] {
  return [...new Set(values.filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0))];
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
