import { createRequire } from "node:module";
import type { DB } from "../storage/connection.js";

export interface MemoryVectorHit {
  memoryId: number;
  distance: number;
  score: number;
}

/** Dimension-specific sqlite-vec index for active memory retrieval. */
export class MemoryVecIndex {
  private available = false;

  constructor(
    private readonly db: DB,
    private readonly dimensions: number,
    private readonly forceUnavailable = false,
  ) {}

  isAvailable(): boolean { return this.available; }
  tableName(): string { return `memory_vec_${this.dimensions}`; }

  ensureSchema(): boolean {
    if (this.forceUnavailable) return false;
    try {
      const require = createRequire(import.meta.url);
      const sqliteVec = require("sqlite-vec") as { load(db: { loadExtension(path: string): void }): void };
      sqliteVec.load(this.db);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName()} USING vec0(
          memory_id INTEGER PRIMARY KEY,
          embedding FLOAT[${this.dimensions}] distance_metric=cosine
        )
      `);
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  upsert(memoryId: number, embedding: Float32Array): void {
    this.assertDimensions(embedding);
    if (!this.available) throw new Error("sqlite-vec memory index is unavailable");
    const key = BigInt(memoryId);
    const write = this.db.transaction(() => {
      // vec0 does not implement SQLite's OR REPLACE conflict behavior.
      this.db.prepare(`DELETE FROM ${this.tableName()} WHERE memory_id = ?`).run(key);
      this.db.prepare(`
        INSERT INTO ${this.tableName()} (memory_id, embedding)
        VALUES (?, ?)
      `).run(key, vectorToBuffer(embedding));
    });
    write();
  }

  search(query: Float32Array, limit: number): MemoryVectorHit[] {
    this.assertDimensions(query);
    if (!this.available) return [];
    const rows = this.db.prepare(`
      SELECT memory_id, distance
      FROM ${this.tableName()}
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(vectorToBuffer(query), limit) as Array<{ memory_id: number; distance: number }>;
    return rows.map((row) => ({
      memoryId: Number(row.memory_id),
      distance: row.distance,
      score: Math.max(-1, Math.min(1, 1 - row.distance)),
    }));
  }

  private assertDimensions(vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`sqlite-vec dimension mismatch: expected ${this.dimensions}, got ${vector.length}`);
    }
  }
}

function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}
