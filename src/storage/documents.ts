import { createHash } from "node:crypto";
import type { DB } from "./connection.js";

export type DocumentType = "trace" | "observation" | "memory" | "summary" | "episode";

export interface DocumentRow {
  id: string;
  doc_type: DocumentType;
  source_id: string;
  session_id: string | null;
  content: string;
  content_hash: string;
  files: string[];
  tags: string[];
  importance: number;
  confidence: number;
  recency_ts: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface UpsertDocumentInput {
  id: string;
  doc_type: DocumentType;
  source_id: string;
  session_id?: string | null;
  content: string;
  files?: string[];
  tags?: string[];
  importance?: number;
  confidence?: number;
  recency_ts?: number;
  created_at?: number;
  updated_at?: number;
  deleted_at?: number | null;
}

export interface SparseSearchInput {
  query: string;
  files?: string[];
  types?: DocumentType[];
  sessionId?: string;
  limit?: number;
}

export interface SparseHit {
  document: DocumentRow;
  bm25: number;
  score: number;
}

export class DocumentStore {
  constructor(private readonly db: DB) {}

  upsertDocument(input: UpsertDocumentInput): DocumentRow {
    const now = Date.now();
    const createdAt = input.created_at ?? now;
    const updatedAt = input.updated_at ?? now;
    const files = normalizeList(input.files);
    const tags = normalizeList(input.tags);
    const contentHash = sha256(input.content);

    this.db.prepare(`
      INSERT INTO documents (
        id, doc_type, source_id, session_id, content, content_hash,
        files_json, tags_json, importance, confidence, recency_ts,
        created_at, updated_at, deleted_at
      )
      VALUES (
        @id, @docType, @sourceId, @sessionId, @content, @contentHash,
        @filesJson, @tagsJson, @importance, @confidence, @recencyTs,
        @createdAt, @updatedAt, @deletedAt
      )
      ON CONFLICT(id) DO UPDATE SET
        doc_type = excluded.doc_type,
        source_id = excluded.source_id,
        session_id = excluded.session_id,
        content = excluded.content,
        content_hash = excluded.content_hash,
        files_json = excluded.files_json,
        tags_json = excluded.tags_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        recency_ts = excluded.recency_ts,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `).run({
      id: input.id,
      docType: input.doc_type,
      sourceId: input.source_id,
      sessionId: input.session_id ?? null,
      content: input.content,
      contentHash,
      filesJson: JSON.stringify(files),
      tagsJson: JSON.stringify(tags),
      importance: clamp01(input.importance ?? 0.5),
      confidence: clamp01(input.confidence ?? 0.5),
      recencyTs: input.recency_ts ?? updatedAt,
      createdAt,
      updatedAt,
      deletedAt: input.deleted_at ?? null,
    });

    const row = this.getDocument(input.id);
    if (!row) throw new Error(`failed to upsert document ${input.id}`);
    return row;
  }

  getDocument(id: string): DocumentRow | null {
    const row = this.db.prepare(`SELECT * FROM documents WHERE id = ?`).get(id);
    return row ? mapDocument(row) : null;
  }

  hydrateDocuments(ids: string[]): DocumentRow[] {
    if (ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    const placeholders = uniqueIds.map(() => "?").join(",");
    const rows = this.db.prepare(`
      SELECT * FROM documents
      WHERE id IN (${placeholders})
    `).all(...uniqueIds);
    const byId = new Map(rows.map((row) => {
      const document = mapDocument(row);
      return [document.id, document] as const;
    }));
    return uniqueIds.flatMap((id) => {
      const document = byId.get(id);
      return document ? [document] : [];
    });
  }

  softDeleteDocument(id: string, deletedAt = Date.now()): void {
    this.db.prepare(`
      UPDATE documents
      SET deleted_at = @deletedAt, updated_at = @deletedAt
      WHERE id = @id
    `).run({ id, deletedAt });
  }

  hardDeleteDocument(id: string): void {
    this.db.prepare(`DELETE FROM documents WHERE id = ?`).run(id);
  }

  searchSparse(input: SparseSearchInput): SparseHit[] {
    const query = buildFtsQuery(input.query, input.files ?? []);
    if (!query) return [];

    const clauses = [
      "documents_fts MATCH @query",
      "d.deleted_at IS NULL",
    ];
    const params: Record<string, unknown> = {
      query,
      limit: input.limit ?? 20,
    };

    if (input.types && input.types.length > 0) {
      clauses.push(`d.doc_type IN (${input.types.map((_, i) => `@type${i}`).join(", ")})`);
      input.types.forEach((type, i) => {
        params[`type${i}`] = type;
      });
    }

    if (input.sessionId) {
      clauses.push("d.session_id = @sessionId");
      params.sessionId = input.sessionId;
    }

    const rows = this.db.prepare(`
      SELECT d.*, bm25(documents_fts) AS bm25_score
      FROM documents_fts
      JOIN documents d ON documents_fts.rowid = d.rowid
      WHERE ${clauses.join(" AND ")}
      ORDER BY bm25_score ASC
      LIMIT @limit
    `).all(params);

    return rows.map((row) => {
      const anyRow = row as { bm25_score: number };
      return {
        document: mapDocument(row),
        bm25: anyRow.bm25_score,
        score: bm25ToScore(anyRow.bm25_score),
      };
    });
  }
}

export function buildFtsQuery(query: string, files: string[] = []): string {
  const terms = [...tokenize(query), ...files.flatMap(tokenizePath)];
  const uniqueTerms = [...new Set(terms)];
  return uniqueTerms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
    .slice(0, 32);
}

function tokenizePath(path: string): string[] {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return [
    normalized,
    ...normalized.split(/[/._-]+/u),
  ].filter((part) => part.length >= 2);
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function bm25ToScore(bm25: number): number {
  return 1 / (1 + Math.max(0, Math.abs(bm25)));
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapDocument(row: unknown): DocumentRow {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    doc_type: r.doc_type as DocumentType,
    source_id: String(r.source_id),
    session_id: typeof r.session_id === "string" ? r.session_id : null,
    content: String(r.content),
    content_hash: String(r.content_hash),
    files: parseJsonArray(r.files_json),
    tags: parseJsonArray(r.tags_json),
    importance: Number(r.importance),
    confidence: Number(r.confidence),
    recency_ts: Number(r.recency_ts),
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
    deleted_at: r.deleted_at == null ? null : Number(r.deleted_at),
  };
}
