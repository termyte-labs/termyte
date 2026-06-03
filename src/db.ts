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

export function openDatabase(dbPath: string): DatabaseContext {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      raw_command TEXT NOT NULL,
      redacted_command TEXT NOT NULL,
      semantic_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation TEXT NOT NULL,
      decision TEXT NOT NULL,
      risk_score INTEGER,
      risk_reason TEXT,
      target_summary TEXT NOT NULL,
      target_count INTEGER NOT NULL,
      executed INTEGER NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      status TEXT NOT NULL,
      env_keys_json TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_created_at ON ledger(created_at);
    CREATE INDEX IF NOT EXISTS idx_ledger_semantic_id ON ledger(semantic_id);

    CREATE TABLE IF NOT EXISTS memory_entries (
      semantic_id TEXT NOT NULL,
      workspace_root TEXT NOT NULL,
      kind TEXT NOT NULL,
      operation TEXT NOT NULL,
      sample_command TEXT NOT NULL,
      last_outcome TEXT NOT NULL,
      total_count INTEGER NOT NULL,
      allow_count INTEGER NOT NULL,
      warn_count INTEGER NOT NULL,
      block_count INTEGER NOT NULL,
      fail_count INTEGER NOT NULL,
      false_positive_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (semantic_id, workspace_root)
    );

    CREATE TABLE IF NOT EXISTS policy_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      block_json TEXT NOT NULL,
      warn_json TEXT NOT NULL,
      default_version INTEGER NOT NULL DEFAULT 0,
      customized INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  ensureColumn(db, "memory_entries", "false_positive_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "policy_state", "default_version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "policy_state", "customized", "INTEGER NOT NULL DEFAULT 0");

  return { db, dbPath };
}

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((row) => row.name === column)) {
    return;
  }

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
