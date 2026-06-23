import type Database from "better-sqlite3";
import type { Observation } from "../types.js";

export interface SearchOptions {
  project?: string;
  agentType?: string;
  agentId?: string;
  promptNumber?: number;
  sinceEpoch?: number;
  limit?: number;
}

export interface SearchResult {
  observations: Observation[];
  totalCount: number;
}

export class SessionSearch {
  constructor(private db: Database.Database) {}

  searchFts(query: string, options: SearchOptions = {}): SearchResult {
    const ftsQuery = this.toFtsQuery(query);
    if (!ftsQuery) {
      return { observations: [], totalCount: 0 };
    }

    const conditions: string[] = ["o.id IN (SELECT rowid FROM observations_fts WHERE observations_fts MATCH ?)"];
    const params: unknown[] = [ftsQuery];

    if (options.project) { conditions.push("o.project = ?"); params.push(options.project); }
    if (options.agentType) { conditions.push("o.agent_type = ?"); params.push(options.agentType); }
    if (options.agentId) { conditions.push("o.agent_id = ?"); params.push(options.agentId); }
    if (options.sinceEpoch) { conditions.push("o.created_at_epoch >= ?"); params.push(options.sinceEpoch); }

    const whereClause = conditions.join(" AND ");
    const limit = options.limit ?? 20;

    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM observations o WHERE ${whereClause}`).get(...params) as any;
    const totalCount = countRow?.cnt ?? 0;

    const rows = this.db.prepare(`
      SELECT o.* FROM observations o
      WHERE ${whereClause}
      ORDER BY o.created_at_epoch DESC
      LIMIT ?
    `).all(...params, limit) as any[];

    return {
      observations: rows.map(this.rowToObservation),
      totalCount,
    };
  }

  searchByContentHash(contentHash: string): Observation | null {
    const row = this.db.prepare(
      "SELECT * FROM observations WHERE content_hash = ? ORDER BY created_at_epoch DESC LIMIT 1"
    ).get(contentHash) as any;
    return row ? this.rowToObservation(row) : null;
  }

  getObservationsForSession(memorySessionId: string): Observation[] {
    const rows = this.db.prepare(
      "SELECT * FROM observations WHERE memory_session_id = ? ORDER BY prompt_number ASC, created_at_epoch ASC"
    ).all(memorySessionId) as any[];
    return rows.map(this.rowToObservation);
  }

  private toFtsQuery(query: string): string {
    const cleaned = query.replace(/[^\w\s]/g, " ").trim();
    if (!cleaned) return "";
    const terms = cleaned.split(/\s+/).filter(Boolean);
    return terms.map(t => `"${t}"`).join(" OR ");
  }

  private rowToObservation(row: any): Observation {
    return {
      id: row.id,
      memorySessionId: row.memory_session_id,
      project: row.project,
      text: row.text,
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      facts: row.facts,
      narrative: row.narrative,
      concepts: row.concepts,
      filesRead: row.files_read,
      filesModified: row.files_modified,
      promptNumber: row.prompt_number,
      discoveryTokens: row.discovery_tokens,
      contentHash: row.content_hash,
      agentType: row.agent_type,
      agentId: row.agent_id,
      generatedByModel: row.generated_by_model,
      relevanceCount: row.relevance_count,
      metadata: row.metadata,
      createdAt: row.created_at,
      createdAtEpoch: row.created_at_epoch,
    };
  }
}
