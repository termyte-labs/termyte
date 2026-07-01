import type { DB } from "./connection.js";

/**
 * The Termyte schema. Five tables.
 *
 *   sessions(id, session_id, project, repo_id, workspace_root,
 *            started_at, ended_at)
 *   traces(id, session_id, timestamp, event_type, tool_name, tool_input,
 *          tool_output, files_read, files_modified, user_prompt,
 *          final_response, processed_at)
 *   observations(id, session_id, repo_id, workspace_root, type,
 *                title, description, files_read, files_modified,
 *                commands_executed, source_trace_ids, created_at,
 *                processed_at, embedding)
 *   memories(id, session_id, repo_id, workspace_root, type, title,
 *            description, files_read, files_modified,
 *            source_observation_ids, source_trace_ids, created_at,
 *            embedding)
 *   summaries(id, session_id, repo_id, workspace_root, summary,
 *             key_changes, key_learnings, created_at)
 *
 * JSON columns are stored as TEXT. Embeddings as BLOBs (Float32).
 *
 * FTS5 mirrors: observations_fts, memories_fts (content-sync triggers).
 * vec0 virtual table: memories_vec (via sqlite-vec extension).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
  repo_id TEXT,
  workspace_root TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN
    ('session_init', 'user_prompt', 'tool_use', 'assistant_message', 'session_end')),
  tool_name TEXT,
  tool_input TEXT,
  tool_output TEXT,
  files_read TEXT,
  files_modified TEXT,
  user_prompt TEXT,
  final_response TEXT,
  processed_at INTEGER,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id);
CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_traces_unprocessed
  ON traces(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('pending', 'leased', 'succeeded', 'failed', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  lease_owner TEXT,
  lease_until INTEGER,
  next_run_at INTEGER NOT NULL,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(kind, subject_type, subject_id)
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON jobs(state, next_run_at, kind);
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs(state, lease_until);
CREATE INDEX IF NOT EXISTS jobs_subject_idx ON jobs(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('bugfix', 'convention', 'warning', 'procedure', 'fact')),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  commands_executed TEXT NOT NULL DEFAULT '[]',
  source_trace_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  processed_at INTEGER,
  embedding BLOB,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(session_id);
CREATE INDEX IF NOT EXISTS idx_observations_repo ON observations(repo_id);
CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_observations_unprocessed
  ON observations(processed_at) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('bugfix', 'convention', 'warning', 'procedure', 'fact')),
  title TEXT NOT NULL,
  description TEXT,
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  source_observation_ids TEXT NOT NULL DEFAULT '[]',
  source_trace_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  embedding BLOB,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN
    ('active', 'stale', 'superseded', 'conflicted', 'deleted')),
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at INTEGER,
  last_reinforced_at INTEGER,
  decayed_score REAL NOT NULL DEFAULT 0.5,
  content_hash TEXT,
  canonical_key TEXT,
  superseded_by INTEGER REFERENCES memories(id),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
CREATE INDEX IF NOT EXISTS idx_memories_canonical_key ON memories(canonical_key);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  repo_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  summary TEXT,
  key_changes TEXT NOT NULL DEFAULT '[]',
  key_learnings TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_summaries_repo ON summaries(repo_id);
CREATE INDEX IF NOT EXISTS idx_summaries_created ON summaries(created_at DESC);

-- FTS5 mirror for observations
CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title,
  description,
  content='observations',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS obs_ad AFTER DELETE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS obs_au AFTER UPDATE ON observations BEGIN
  INSERT INTO observations_fts(observations_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
  INSERT INTO observations_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

-- FTS5 mirror for memories
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  description,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS mem_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TRIGGER IF NOT EXISTS mem_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
END;

CREATE TRIGGER IF NOT EXISTS mem_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, description)
  VALUES('delete', old.id, old.title, old.description);
  INSERT INTO memories_fts(rowid, title, description)
  VALUES (new.id, new.title, new.description);
END;

CREATE TABLE IF NOT EXISTS memory_edges (
  id TEXT PRIMARY KEY,
  source_memory_id INTEGER NOT NULL REFERENCES memories(id),
  target_memory_id INTEGER NOT NULL REFERENCES memories(id),
  edge_type TEXT NOT NULL CHECK(edge_type IN
    ('supports', 'contradicts', 'supersedes', 'duplicates', 'derived_from', 'related_to')),
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER NOT NULL,
  UNIQUE(source_memory_id, target_memory_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_memory_edges_source ON memory_edges(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_target ON memory_edges(target_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_edges_type ON memory_edges(edge_type);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id TEXT PRIMARY KEY,
  memory_id INTEGER NOT NULL REFERENCES memories(id),
  doc_id TEXT,
  event_type TEXT NOT NULL CHECK(event_type IN
    ('shown', 'used', 'ignored', 'downranked', 'corrected')),
  weight REAL NOT NULL,
  source TEXT NOT NULL,
  context_injection_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_memory ON memory_feedback(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_feedback_context ON memory_feedback(context_injection_id);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  doc_type TEXT NOT NULL CHECK(doc_type IN
    ('trace', 'observation', 'memory', 'summary', 'episode')),
  source_id TEXT NOT NULL,
  session_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  files_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  recency_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  UNIQUE(doc_type, source_id)
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_session ON documents(session_id);
CREATE INDEX IF NOT EXISTS idx_documents_recency ON documents(recency_ts DESC);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted_at);

CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  content,
  files,
  tags,
  content='documents',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents BEGIN
  INSERT INTO documents_fts(rowid, content, files, tags)
  VALUES (new.rowid, new.content, new.files_json, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, files, tags)
  VALUES('delete', old.rowid, old.content, old.files_json, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
  INSERT INTO documents_fts(documents_fts, rowid, content, files, tags)
  VALUES('delete', old.rowid, old.content, old.files_json, old.tags_json);
  INSERT INTO documents_fts(rowid, content, files, tags)
  VALUES (new.rowid, new.content, new.files_json, new.tags_json);
END;

CREATE TABLE IF NOT EXISTS document_embeddings (
  doc_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dimensions INTEGER NOT NULL,
  vector_table TEXT NOT NULL,
  embedded_at INTEGER NOT NULL,
  embedding_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_embeddings_model ON document_embeddings(model, dimensions);
`;

export function runMigrations(db: DB): void {
  db.exec(SCHEMA);
  ensurePipelineColumns(db);
  ensureLifecycleColumns(db);
}

function ensurePipelineColumns(db: DB): void {
  addColumnIfMissing(db, "traces", "pipeline_state", "TEXT DEFAULT 'captured'");
  addColumnIfMissing(db, "observations", "lifecycle_state", "TEXT DEFAULT 'extracting'");
  addColumnIfMissing(db, "memories", "lifecycle_state", "TEXT DEFAULT 'consolidating'");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_pipeline_state ON traces(pipeline_state);
    CREATE INDEX IF NOT EXISTS idx_observations_lifecycle_state ON observations(lifecycle_state);
    CREATE INDEX IF NOT EXISTS idx_memories_lifecycle_state ON memories(lifecycle_state);
  `);
}

function ensureLifecycleColumns(db: DB): void {
  addColumnIfMissing(db, "memories", "state", "TEXT NOT NULL DEFAULT 'active'");
  addColumnIfMissing(db, "memories", "importance", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "confidence", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "usage_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "memories", "last_accessed_at", "INTEGER");
  addColumnIfMissing(db, "memories", "last_reinforced_at", "INTEGER");
  addColumnIfMissing(db, "memories", "decayed_score", "REAL NOT NULL DEFAULT 0.5");
  addColumnIfMissing(db, "memories", "content_hash", "TEXT");
  addColumnIfMissing(db, "memories", "canonical_key", "TEXT");
  addColumnIfMissing(db, "memories", "superseded_by", "INTEGER REFERENCES memories(id)");

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memories_state ON memories(state);
    CREATE INDEX IF NOT EXISTS idx_memories_canonical_key ON memories(canonical_key);
  `);
}

function addColumnIfMissing(db: DB, table: string, column: string, ddl: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * Create a vec0 virtual table for vector search using sqlite-vec.
 * Call this after sqlite-vec extension is loaded.
 * Falls back silently if the extension is not loaded.
 */
export function tryCreateVecTable(db: DB, dimensions: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        embedding float[${dimensions}]
      )
    `);
    return true;
  } catch {
    return false;
  }
}
