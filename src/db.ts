import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export interface DatabaseContext {
  db: Database.Database;
  dbPath: string;
}

export function defaultDbPath(workspaceRoot: string): string {
  return process.env.TERMYTE_DB_PATH ?? path.join(workspaceRoot, ".termyte", "termyte.db");
}

export function ensureDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

export function openDatabase(dbPath: string): DatabaseContext {
  ensureDir(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  initSchema(db);
  return { db, dbPath };
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      branch TEXT,
      start_commit TEXT,
      end_commit TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      timestamp TEXT NOT NULL,
      source TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_name TEXT,
      event_type TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL,
      correlation_id TEXT,
      confidence REAL DEFAULT 1.0
    );
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);

    CREATE TABLE IF NOT EXISTS raw_payloads (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      raw_json TEXT,
      raw_text TEXT,
      redacted INTEGER NOT NULL DEFAULT 0,
      schema_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS command_events (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      command TEXT NOT NULL,
      shell TEXT,
      cwd TEXT,
      exit_code INTEGER,
      stdout_excerpt TEXT,
      stderr_excerpt TEXT,
      duration_ms INTEGER,
      semantic_id TEXT
    );

    CREATE TABLE IF NOT EXISTS file_touches (
      event_id TEXT PRIMARY KEY REFERENCES events(id),
      path TEXT NOT NULL,
      operation TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      lines_added INTEGER,
      lines_removed INTEGER,
      diff_excerpt TEXT,
      ast_anchors TEXT
    );

    CREATE TABLE IF NOT EXISTS failures (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id TEXT REFERENCES events(id),
      fingerprint TEXT NOT NULL,
      category TEXT NOT NULL,
      message TEXT NOT NULL,
      failing_file TEXT,
      failing_test TEXT,
      command TEXT,
      first_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_failures_fingerprint ON failures(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_failures_session ON failures(session_id);

    CREATE TABLE IF NOT EXISTS event_links (
      from_event_id TEXT NOT NULL REFERENCES events(id),
      to_event_id TEXT NOT NULL REFERENCES events(id),
      relation TEXT NOT NULL,
      PRIMARY KEY (from_event_id, to_event_id, relation)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      type TEXT NOT NULL,
      repo_scope TEXT NOT NULL,
      language TEXT,
      ast_anchors TEXT,
      sources TEXT NOT NULL DEFAULT '[]',
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      last_verified TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      consolidated_from TEXT,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(repo_scope);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_active);

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL REFERENCES memories(id),
      used_at TEXT NOT NULL,
      context TEXT,
      outcome TEXT NOT NULL,
      outcome_detail TEXT,
      session_id TEXT REFERENCES sessions(id)
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_memory ON memory_feedback(memory_id);

    CREATE TABLE IF NOT EXISTS procedures (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      repo_scope TEXT NOT NULL,
      step_count INTEGER NOT NULL,
      steps TEXT NOT NULL,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        claim,
        type,
        repo_scope,
        language,
        content='memories',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
    `);
  } catch {
    // FTS5 table may already exist
  }
}

export function closeDatabase(ctx: DatabaseContext): void {
  ctx.db.close();
}
