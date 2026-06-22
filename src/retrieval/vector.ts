import type Database from "better-sqlite3";
import type { Memory } from "../types.js";
import { rowToMemory } from "../memory/schema.js";

export interface VectorResult {
  memory: Memory;
  distance: number;
  score: number;
}

function serializeFloat32(vector: number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    buffer.writeFloatLE(vector[i], i * 4);
  }
  return buffer;
}

export function storeEmbedding(
  db: Database.Database,
  memoryId: string,
  embedding: number[],
): void {
  const buffer = serializeFloat32(embedding);
  try {
    db.prepare(`
      INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding)
      VALUES (?, ?)
    `).run(memoryId, buffer);
  } catch {
    // If vec0 table doesn't exist, try creating it and retrying
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding float[768],
          distance_metric=cosine
        )
      `);
      db.prepare("INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding) VALUES (?, ?)").run(memoryId, buffer);
    } catch {
      // Vector storage is optional
    }
  }
}

export function vectorSearch(
  db: Database.Database,
  queryEmbedding: number[],
  limit: number = 20,
): VectorResult[] {
  const buffer = serializeFloat32(queryEmbedding);

  try {
    const results = db.prepare(`
      SELECT memory_id, distance
      FROM memory_embeddings
      WHERE embedding MATCH ?
      AND k = ?
      ORDER BY distance
    `).all(buffer, limit) as Array<{ memory_id: string; distance: number }>;

    return results.map((r) => {
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(r.memory_id);
      if (!row) return null;
      const memory = rowToMemory(row as Parameters<typeof rowToMemory>[0]);
      // Cosine distance: lower is better, convert to score (0-1, higher is better)
      const score = Math.max(0, 1 - r.distance);
      return { memory, distance: r.distance, score };
    }).filter((r): r is VectorResult => r !== null);
  } catch {
    return [];
  }
}

export function ensureVectorTable(db: Database.Database): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[768],
        distance_metric=cosine
      )
    `);
  } catch {
    // Table may already exist or sqlite-vec not loaded
  }
}
