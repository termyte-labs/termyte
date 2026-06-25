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
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_repo ON memories(repo_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

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
`;

export function runMigrations(db: DB): void {
  db.exec(SCHEMA);
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
