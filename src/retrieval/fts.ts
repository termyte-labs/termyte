import type Database from "better-sqlite3";
import type { Memory } from "../types.js";
import { rowToMemory } from "../memory/schema.js";

interface FtsResult {
  rowid: number;
  rank: number;
}

export interface KeywordResult {
  memory: Memory;
  score: number;
}

function toFtsQuery(query: string): string {
  const cleaned = query.replace(/[^\w\s]/g, " ").trim();
  if (!cleaned) return "";
  const terms = cleaned.split(/\s+/).filter(Boolean);
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

export function keywordSearch(
  db: Database.Database,
  query: string,
  limit: number = 20,
): KeywordResult[] {
  if (!query.trim()) return [];

  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const ftsResults = db.prepare(`
      SELECT rowid, rank FROM memories_fts
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit * 2) as FtsResult[];

    if (ftsResults.length === 0) return [];

    const maxRank = Math.max(...ftsResults.map((r) => Math.abs(r.rank)), 1);

    return ftsResults.map((r) => {
      const row = db.prepare("SELECT * FROM memories WHERE rowid = ?").get(r.rowid) as Record<string, unknown> | undefined;
      if (!row) return null;
      const memory = rowToMemory(row as any);
      const normalizedScore = 1 - Math.abs(r.rank) / maxRank;
      return { memory, score: Math.max(0, normalizedScore) };
    }).filter((r): r is KeywordResult => r !== null);
  } catch {
    return [];
  }
}
