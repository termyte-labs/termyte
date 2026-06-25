import type { Store } from "../storage/store.js";
import type { Memory } from "../core/types.js";

export interface FTSSearchOptions {
  query: string;
  project?: string;
  limit?: number;
  type?: string;
}

/**
 * Full-text search over the `memories_fts` FTS5 mirror. Returns memories
 * ranked by FTS5 rank.
 */
export class FTSSearch {
  constructor(private store: Store) {}

  search(options: FTSSearchOptions): Memory[] {
    const ftsQuery = buildFTSQuery(options.query);
    if (!ftsQuery) return [];

    const params: any[] = [ftsQuery];
    const where: string[] = ["memories_fts MATCH ?"];

    if (options.project) {
      where.push("s.project = ?");
      params.push(options.project);
    }
    if (options.type) {
      where.push("m.type = ?");
      params.push(options.type);
    }

    const limit = options.limit ?? 20;
    params.push(limit);

    const sql = options.project
      ? `
        SELECT m.id, m.session_id, m.type, m.title, m.subtitle, m.facts,
               m.narrative, m.concepts, m.files_read, m.files_modified,
               m.created_at, m.embedding
        FROM memories m
        INNER JOIN memories_fts fts ON fts.rowid = m.id
        INNER JOIN sessions s ON s.session_id = m.session_id
        WHERE ${where.join(" AND ")}
        ORDER BY rank
        LIMIT ?
      `
      : `
        SELECT m.id, m.session_id, m.type, m.title, m.subtitle, m.facts,
               m.narrative, m.concepts, m.files_read, m.files_modified,
               m.created_at, m.embedding
        FROM memories m
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
    type: row.type,
    title: row.title,
    subtitle: row.subtitle,
    facts: parseJSON(row.facts, []),
    narrative: row.narrative,
    concepts: parseJSON(row.concepts, []),
    files_read: parseJSON(row.files_read, []),
    files_modified: parseJSON(row.files_modified, []),
    created_at: row.created_at,
    embedding,
  };
}

function parseJSON<T>(s: string, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
