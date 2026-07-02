import type { Store } from "../storage/store.js";
import type { Memory, MemoryType } from "../core/types.js";
import { memoryEligibilitySql } from "./eligibility.js";

export interface FTSSearchOptions {
  query: string;
  repo_id?: string;
  limit?: number;
  type?: string;
  /** Override the default lifecycle eligibility policy. */
  eligibleStates?: readonly string[];
}

export class FTSSearch {
  constructor(private store: Store) {}

  search(options: FTSSearchOptions): Memory[] {
    const ftsQuery = buildFTSQuery(options.query);
    if (!ftsQuery) return [];

    const eligibility = memoryEligibilitySql("m", options.eligibleStates);
    const params: any[] = [ftsQuery, ...eligibility.params];
    const where: string[] = ["memories_fts MATCH ?", eligibility.clause];

    if (options.repo_id) {
      where.push("m.repo_id = ?");
      params.push(options.repo_id);
    }
    if (options.type) {
      where.push("m.type = ?");
      params.push(options.type);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    const sql = `
      SELECT m.* FROM memories m
      INNER JOIN memories_fts fts ON fts.rowid = m.id
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?
    `;

    const rows = this.store.getDB().prepare(sql).all(...params) as any[];
    return rows.map(mapMemoryRow);
  }
}

function buildFTSQuery(query: string): string {
  return query
    .normalize("NFKC")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(" ");
}

function mapMemoryRow(row: any): Memory {
  let embedding: Float32Array | null = null;
  if (row.embedding) {
    const buf = row.embedding as Buffer;
    embedding = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  return {
    id: row.id,
    session_id: row.session_id,
    repo_id: row.repo_id,
    workspace_root: row.workspace_root,
    type: row.type as MemoryType,
    title: row.title,
    description: row.description,
    files_read: parseJSON<string[]>(row.files_read, []),
    files_modified: parseJSON<string[]>(row.files_modified, []),
    source_observation_ids: parseJSON<number[]>(row.source_observation_ids, []),
    source_trace_ids: parseJSON<number[]>(row.source_trace_ids, []),
    created_at: row.created_at,
    embedding,
    lifecycle_state: row.lifecycle_state,
    state: row.state,
  };
}

function parseJSON<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
