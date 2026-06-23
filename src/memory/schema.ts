import type Database from "better-sqlite3";
import type { Memory, MemoryType } from "../types.js";
import { computeConfidence } from "./confidence.js";

interface MemoryRow {
  rowid?: number;
  id: string;
  claim: string;
  type: string;
  repo_scope: string;
  language: string | null;
  ast_anchors: string | null;
  sources: string;
  files_read: string | null;
  files_modified: string | null;
  concepts: string | null;
  success_count: number;
  failure_count: number;
  confidence: number;
  last_outcome_at: string | null;
  last_outcome_type: string | null;
  consolidated_from: string | null;
  consolidation_kind: string | null;
  consolidation_rationale: string | null;
  created_at: string;
  updated_at: string;
  is_active: number;
}

export function rowToMemory(row: MemoryRow): Memory {
  return {
    id: row.id,
    claim: row.claim,
    type: row.type as MemoryType,
    repoScope: row.repo_scope,
    language: row.language ?? undefined,
    astAnchors: row.ast_anchors ? JSON.parse(row.ast_anchors) : undefined,
    sources: JSON.parse(row.sources),
    filesRead: row.files_read ?? undefined,
    filesModified: row.files_modified ?? undefined,
    concepts: row.concepts ?? undefined,
    successCount: row.success_count,
    failureCount: row.failure_count,
    confidence: row.confidence,
    lastOutcomeAt: row.last_outcome_at ?? undefined,
    lastOutcomeType: row.last_outcome_type ?? undefined,
    consolidatedFrom: row.consolidated_from ? JSON.parse(row.consolidated_from) : undefined,
    consolidationKind: row.consolidation_kind as Memory["consolidationKind"],
    consolidationRationale: row.consolidation_rationale ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isActive: row.is_active === 1,
  };
}

export interface InsertMemoryInput {
  id: string;
  claim: string;
  type: MemoryType;
  repoScope: string;
  language?: string;
  astAnchors?: unknown[];
  sources: string[];
  filesRead?: string;
  filesModified?: string;
  concepts?: string;
  successCount?: number;
  failureCount?: number;
  confidence?: number;
  consolidatedFrom?: string[];
  consolidationKind?: Memory["consolidationKind"];
  consolidationRationale?: string;
  createdAt: string;
  updatedAt: string;
}

export class MemoryStore {
  constructor(private readonly db: Database.Database) {}

  insert(input: InsertMemoryInput): Memory {
    const stmt = this.db.prepare(`
      INSERT INTO memories (id, claim, type, repo_scope, language, ast_anchors, sources, files_read, files_modified, concepts, success_count, failure_count, confidence, consolidated_from, consolidation_kind, consolidation_rationale, created_at, updated_at, is_active)
      VALUES (@id, @claim, @type, @repo_scope, @language, @ast_anchors, @sources, @files_read, @files_modified, @concepts, @success_count, @failure_count, @confidence, @consolidated_from, @consolidation_kind, @consolidation_rationale, @created_at, @updated_at, 1)
    `);
    stmt.run({
      id: input.id,
      claim: input.claim,
      type: input.type,
      repo_scope: input.repoScope,
      language: input.language ?? null,
      ast_anchors: input.astAnchors ? JSON.stringify(input.astAnchors) : undefined,
      sources: JSON.stringify(input.sources),
      files_read: input.filesRead ?? null,
      files_modified: input.filesModified ?? null,
      concepts: input.concepts ?? null,
      success_count: input.successCount ?? 0,
      failure_count: input.failureCount ?? 0,
      confidence: input.confidence ?? 0.5,
      consolidated_from: input.consolidatedFrom ? JSON.stringify(input.consolidatedFrom) : null,
      consolidation_kind: input.consolidationKind ?? null,
      consolidation_rationale: input.consolidationRationale ?? null,
      created_at: input.createdAt,
      updated_at: input.updatedAt,
    });
    this.syncFts(input.id);
    return this.getById(input.id)!;
  }

  getById(id: string): Memory | null {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? rowToMemory(row) : null;
  }

  list(options: { type?: MemoryType; scope?: string; activeOnly?: boolean; limit?: number } = {}): Memory[] {
    let query = "SELECT * FROM memories WHERE 1=1";
    const params: unknown[] = [];

    if (options.type) {
      query += " AND type = ?";
      params.push(options.type);
    }
    if (options.scope) {
      query += " AND repo_scope = ?";
      params.push(options.scope);
    }
    if (options.activeOnly !== false) {
      query += " AND is_active = 1";
    }
    query += " ORDER BY updated_at DESC";
    if (options.limit) {
      query += " LIMIT ?";
      params.push(options.limit);
    }

    const rows = this.db.prepare(query).all(...params) as MemoryRow[];
    return rows.map(rowToMemory);
  }

  updateConfidence(id: string, confidence: number): void {
    this.db.prepare("UPDATE memories SET confidence = ?, updated_at = ? WHERE id = ?").run(
      confidence,
      new Date().toISOString(),
      id,
    );
  }

  recordSuccess(id: string): void {
    const mem = this.getById(id);
    if (!mem) return;
    const newConfidence = computeConfidence(mem.successCount + 1, mem.failureCount);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories
      SET success_count = success_count + 1, confidence = ?, updated_at = ?, last_outcome_at = ?, last_outcome_type = 'success'
      WHERE id = ?
    `).run(newConfidence, now, now, id);
  }

  recordFailure(id: string): void {
    const mem = this.getById(id);
    if (!mem) return;
    const newConfidence = computeConfidence(mem.successCount, mem.failureCount + 1);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE memories
      SET failure_count = failure_count + 1, confidence = ?, updated_at = ?, last_outcome_at = ?, last_outcome_type = 'failure'
      WHERE id = ?
    `).run(newConfidence, now, now, id);
  }

  deactivate(id: string): void {
    this.db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      id,
    );
  }

  deactivateMany(ids: string[]): number {
    if (ids.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?");
    let changed = 0;
    const tx = this.db.transaction((batch: string[]) => {
      for (const id of batch) {
        const r = stmt.run(now, id);
        changed += r.changes;
      }
    });
    tx(ids);
    return changed;
  }

  listScopes(): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT repo_scope FROM memories WHERE is_active = 1 ORDER BY repo_scope
    `).all() as Array<{ repo_scope: string }>;
    return rows.map((r) => r.repo_scope);
  }

  count(options: { type?: MemoryType; scope?: string } = {}): number {
    let query = "SELECT COUNT(*) as cnt FROM memories WHERE is_active = 1";
    const params: unknown[] = [];
    if (options.type) {
      query += " AND type = ?";
      params.push(options.type);
    }
    if (options.scope) {
      query += " AND repo_scope = ?";
      params.push(options.scope);
    }
    const row = this.db.prepare(query).get(...params) as { cnt: number };
    return row.cnt;
  }

  private syncFts(id: string): void {
    const row = this.db.prepare("SELECT rowid, * FROM memories WHERE id = ?").get(id) as (MemoryRow & { rowid: number }) | undefined;
    if (!row) return;
    try {
      this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
      this.db.prepare(`
        INSERT INTO memories_fts(rowid, claim, type, repo_scope, language)
        VALUES (?, ?, ?, ?, ?)
      `).run(row.rowid, row.claim, row.type, row.repo_scope, row.language ?? "");
    } catch (e) {
      // FTS sync is best-effort
      if (process.env.TERMYTE_DEBUG_FTS) {
        console.error("[FTS sync error]", e);
      }
    }
  }
}
