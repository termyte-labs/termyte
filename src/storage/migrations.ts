import type { DB } from "./connection.js";

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
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  platform_event_id TEXT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  tool_name TEXT,
  tool_input TEXT,
  tool_output TEXT,
  files_read TEXT,
  files_modified TEXT,
  user_prompt TEXT,
  final_response TEXT,
  redaction_json TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  ingested_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_traces_session ON traces(session_id, timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_platform_event
  ON traces(session_id, platform_event_id) WHERE platform_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_traces_content
  ON traces(session_id, event_type, timestamp, content_hash) WHERE platform_event_id IS NULL;

CREATE TABLE IF NOT EXISTS handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_session_id TEXT UNIQUE NOT NULL REFERENCES sessions(session_id),
  target_session_id TEXT NOT NULL REFERENCES sessions(session_id),
  repo_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_handoffs_repo ON handoffs(repo_id, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS handoffs_fts USING fts5(
  content,
  content='handoffs',
  content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS handoffs_ai AFTER INSERT ON handoffs BEGIN
  INSERT INTO handoffs_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS handoffs_ad AFTER DELETE ON handoffs BEGIN
  INSERT INTO handoffs_fts(handoffs_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS handoffs_au AFTER UPDATE ON handoffs BEGIN
  INSERT INTO handoffs_fts(handoffs_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO handoffs_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

export function runMigrations(db: DB): void {
  db.exec(SCHEMA);
}
