import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DB } from "../storage/connection.js";

export interface VectorHit {
  docId: string;
  distance: number;
  score: number;
}

export interface SqliteVecIndexOptions {
  dimensions: number;
  model: string;
  forceUnavailable?: boolean;
}

export class SqliteVecIndex {
  private available = false;

  constructor(
    private readonly db: DB,
    private readonly options: SqliteVecIndexOptions,
  ) {}

  isAvailable(): boolean {
    return this.available;
  }

  tableName(): string {
    return `document_vec_${this.options.dimensions}`;
  }

  ensureSchema(): boolean {
    if (this.options.forceUnavailable) {
      this.available = false;
      return false;
    }

    try {
      this.loadExtension();
      this.db.prepare(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName()}
        USING vec0(
          doc_id TEXT PRIMARY KEY,
          embedding FLOAT[${this.options.dimensions}]
        )
      `).run();
      this.available = true;
      return true;
    } catch {
      this.available = false;
      return false;
    }
  }

  upsert(docId: string, vector: Float32Array): void {
    this.assertAvailable();
    this.assertDimensions(vector);

    this.db.prepare(`
      INSERT OR REPLACE INTO ${this.tableName()} (doc_id, embedding)
      VALUES (@docId, @embedding)
    `).run({
      docId,
      embedding: vectorToBuffer(vector),
    });

    this.db.prepare(`
      INSERT OR REPLACE INTO document_embeddings (
        doc_id, model, dimensions, vector_table, embedded_at, embedding_hash
      )
      VALUES (
        @docId, @model, @dimensions, @vectorTable, @embeddedAt, @embeddingHash
      )
    `).run({
      docId,
      model: this.options.model,
      dimensions: this.options.dimensions,
      vectorTable: this.tableName(),
      embeddedAt: Date.now(),
      embeddingHash: hashVector(vector),
    });
  }

  search(vector: Float32Array, limit: number): VectorHit[] {
    if (!this.available) return [];
    this.assertDimensions(vector);

    const rows = this.db.prepare(`
      SELECT doc_id, distance
      FROM ${this.tableName()}
      WHERE embedding MATCH @embedding
      ORDER BY distance
      LIMIT @limit
    `).all({
      embedding: vectorToBuffer(vector),
      limit,
    }) as Array<{ doc_id: string; distance: number }>;

    return rows.map((row) => ({
      docId: row.doc_id,
      distance: row.distance,
      score: 1 / (1 + Math.max(0, row.distance)),
    }));
  }

  private loadExtension(): void {
    try {
      const require = createRequire(import.meta.url);
      const sqliteVec = require("sqlite-vec") as { load(db: { loadExtension(path: string): void }): void };
      sqliteVec.load(this.db);
    } catch {
      // If require is unavailable under ESM or the optional native package is
      // absent, CREATE VIRTUAL TABLE below will fail and mark the index unavailable.
    }
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new Error("sqlite-vec is unavailable; vector index write was not performed");
    }
  }

  private assertDimensions(vector: Float32Array): void {
    if (vector.length !== this.options.dimensions) {
      throw new Error(`sqlite-vec dimension mismatch: expected ${this.options.dimensions}, got ${vector.length}`);
    }
  }
}

function vectorToBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function hashVector(vector: Float32Array): string {
  return createHash("sha256").update(vectorToBuffer(vector)).digest("hex");
}
