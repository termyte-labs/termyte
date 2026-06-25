import type { DB } from "./connection.js";

/**
 * The Termyte schema. Four tables, nothing more.
 *
 *  sessions(id, session_id, project, started_at, ended_at)
 *  traces(id, session_id, timestamp, event_type, tool_name, tool_input,
 *         tool_output, files_read, files_modified, user_prompt,
 *         final_response, processed_at)
 *  memories(id, session_id, type, title, subtitle, facts, narrative,
 *          concepts, files_read, files_modified, created_at, embedding)
 *  summaries(id, session_id, request, investigated, learned, completed,
 *           next_steps, notes, created_at)
 *
 * JSON columns (tool_input, tool_output, files_read, files_modified, facts,
 * concepts) are stored as TEXT and serialized/deserialized at the store
 * boundary. Embeddings are stored as a BLOB (raw Float32 bytes).
 *
 * An FTS5 mirror of `memories` is created alongside, kept in sync via
 * triggers. The mirror indexes title, subtitle, narrative, facts, and
 * concepts.
 *
 * The `processed_at` column on `traces` is operational state, not
 * "metadata" in the content sense. It lets the background observer be
 * crash-safe: unprocessed traces are picked up on the next process start.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  project TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN
    ('bugfix', 'feature', 'refactor', 'change', 'discovery', 'decision')),
  title TEXT NOT NULL,
  subtitle TEXT,
  facts TEXT NOT NULL DEFAULT '[]',
  narrative TEXT,
  concepts TEXT NOT NULL DEFAULT '[]',
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  embedding BLOB,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT UNIQUE NOT NULL,
  request TEXT,
  investigated TEXT,
  learned TEXT,
  completed TEXT,
  next_steps TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  title,
  subtitle,
  narrative,
  facts,
  concepts,
  content='memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, title, subtitle, narrative, facts, concepts)
  VALUES('delete', old.id, old.title, old.subtitle, old.narrative, old.facts, old.concepts);
  INSERT INTO memories_fts(rowid, title, subtitle, narrative, facts, concepts)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts);
END;
`;

export function runMigrations(db: DB): void {
  db.exec(SCHEMA);
}
