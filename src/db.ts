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
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT UNIQUE NOT NULL,
      memory_session_id TEXT UNIQUE,
      project TEXT NOT NULL,
      platform_source TEXT NOT NULL DEFAULT 'termyte',
      user_prompt TEXT,
      started_at TEXT NOT NULL,
      started_at_epoch INTEGER NOT NULL,
      completed_at TEXT,
      completed_at_epoch INTEGER,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','failed')),
      prompt_counter INTEGER DEFAULT 0,
      custom_title TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_content ON sessions(content_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_memory ON sessions(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_epoch DESC);

    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_session_id TEXT NOT NULL,
      project TEXT NOT NULL,
      text TEXT,
      type TEXT NOT NULL,
      title TEXT,
      subtitle TEXT,
      facts TEXT,
      narrative TEXT,
      concepts TEXT,
      files_read TEXT,
      files_modified TEXT,
      prompt_number INTEGER,
      discovery_tokens INTEGER DEFAULT 0,
      content_hash TEXT,
      agent_type TEXT,
      agent_id TEXT,
      generated_by_model TEXT,
      relevance_count INTEGER DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL,
      UNIQUE(memory_session_id, content_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_observations_session ON observations(memory_session_id);
    CREATE INDEX IF NOT EXISTS idx_observations_project ON observations(project);
    CREATE INDEX IF NOT EXISTS idx_observations_type ON observations(type);
    CREATE INDEX IF NOT EXISTS idx_observations_created ON observations(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_observations_content_hash ON observations(content_hash, created_at_epoch);
    CREATE INDEX IF NOT EXISTS idx_observations_agent_type ON observations(agent_type);
    CREATE INDEX IF NOT EXISTS idx_observations_agent_id ON observations(agent_id);

    CREATE TABLE IF NOT EXISTS pending_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_db_id INTEGER NOT NULL,
      content_session_id TEXT NOT NULL,
      tool_use_id TEXT,
      message_type TEXT NOT NULL CHECK(message_type IN ('observation','summarize')),
      tool_name TEXT,
      tool_input TEXT,
      tool_response TEXT,
      cwd TEXT,
      last_user_message TEXT,
      last_assistant_message TEXT,
      prompt_number INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing')),
      created_at_epoch INTEGER NOT NULL,
      agent_type TEXT,
      agent_id TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_pending_session ON pending_messages(session_db_id);
    CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_messages(status);
    CREATE INDEX IF NOT EXISTS idx_pending_content ON pending_messages(content_session_id);

    CREATE TABLE IF NOT EXISTS user_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_session_id TEXT NOT NULL,
      prompt_number INTEGER NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_at_epoch INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(content_session_id);
    CREATE INDEX IF NOT EXISTS idx_prompts_created ON user_prompts(created_at_epoch DESC);
    CREATE INDEX IF NOT EXISTS idx_prompts_number ON user_prompts(prompt_number);
    CREATE INDEX IF NOT EXISTS idx_prompts_lookup ON user_prompts(content_session_id, prompt_number);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      claim TEXT NOT NULL,
      type TEXT NOT NULL,
      repo_scope TEXT NOT NULL,
      language TEXT,
      ast_anchors TEXT,
      sources TEXT NOT NULL DEFAULT '[]',
      files_read TEXT,
      files_modified TEXT,
      concepts TEXT,
      embedding BLOB,
      success_count INTEGER NOT NULL DEFAULT 0,
      failure_count INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      last_outcome_at TEXT,
      last_outcome_type TEXT,
      consolidated_from TEXT,
      consolidation_kind TEXT,
      consolidation_rationale TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(repo_scope);
    CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(is_active);
    -- (idx_memories_consolidated_from is created in the migration block below)

    CREATE TABLE IF NOT EXISTS memory_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL REFERENCES memories(id),
      used_at TEXT NOT NULL,
      context TEXT,
      outcome TEXT NOT NULL,
      outcome_detail TEXT,
      session_id TEXT
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
      CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
        title, subtitle, narrative, text, facts, concepts,
        tokenize='porter unicode61'
      );
    `);
  } catch {
    // FTS5 table may already exist
  }

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        claim, type, repo_scope, language,
        tokenize='porter unicode61'
      );
    `);
  } catch {
    // FTS5 table may already exist
  }

  // Idempotent migrations for older DBs that lack the consolidation columns.
  const memoryCols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  const hasCol = (name: string) => memoryCols.some((c) => c.name === name);
  if (!hasCol("consolidated_from")) {
    try { db.exec("ALTER TABLE memories ADD COLUMN consolidated_from TEXT"); } catch { /* ignore */ }
  }
  if (!hasCol("consolidation_kind")) {
    try { db.exec("ALTER TABLE memories ADD COLUMN consolidation_kind TEXT"); } catch { /* ignore */ }
  }
  if (!hasCol("consolidation_rationale")) {
    try { db.exec("ALTER TABLE memories ADD COLUMN consolidation_rationale TEXT"); } catch { /* ignore */ }
  }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_memories_consolidated_from ON memories(consolidated_from)"); } catch { /* ignore */ }
}

export function closeDatabase(ctx: DatabaseContext): void {
  ctx.db.close();
}
