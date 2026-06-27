import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Schema version tracking tests (L5 from the senior review).
 *
 * We drive runMigrations directly with a real better-sqlite3
 * connection so we can verify the meta table and trigger changes.
 */
describe("schema migrations", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "termyte-mig-"));
    dbPath = join(dir, "test.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function getDb() {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    return db;
  }

  it("creates the meta table and stamps schema_version=3 on a fresh DB", async () => {
    const { runMigrations } = await import("../src/storage/migrations.js");
    const db = getDb();
    runMigrations(db);
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    expect(row.value).toBe("3");
    db.close();
  });

  it("FTS5 update triggers have the OF title, description qualifier", async () => {
    const { runMigrations } = await import("../src/storage/migrations.js");
    const db = getDb();
    runMigrations(db);
    const obs = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='obs_au'`).get() as { sql: string };
    const mem = db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger' AND name='mem_au'`).get() as { sql: string };
    expect(obs.sql).toContain("OF title, description");
    expect(mem.sql).toContain("OF title, description");
    db.close();
  });

  it("is idempotent — running twice does not duplicate triggers or tables", async () => {
    const { runMigrations } = await import("../src/storage/migrations.js");
    const db = getDb();
    runMigrations(db);
    runMigrations(db);
    const triggers = db.prepare(
      `SELECT count(*) as c FROM sqlite_master WHERE type='trigger' AND name IN ('obs_ai','obs_au','obs_ad','mem_ai','mem_au','mem_ad')`
    ).get() as { c: number };
    expect(triggers.c).toBe(6);
    db.close();
  });

  it("adds ingest_status / ingest_error / ingest_attempts to existing DBs missing them", async () => {
    const db = getDb();
    // Simulate a pre-v2 DB: create the table without the new
    // columns, then run migrations.
    db.exec(`CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT UNIQUE NOT NULL,
      project TEXT NOT NULL,
      repo_id TEXT,
      workspace_root TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    )`);
    db.exec(`CREATE TABLE traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      tool_output TEXT,
      files_read TEXT,
      files_modified TEXT,
      user_prompt TEXT,
      final_response TEXT,
      processed_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    )`);
    // Insert a trace with no ingest columns to verify migration.
    db.exec(`INSERT INTO sessions (session_id, project, started_at) VALUES ('s', 'p', 0)`);
    db.exec(`INSERT INTO traces (session_id, timestamp, event_type) VALUES ('s', 0, 'tool_use')`);

    const { runMigrations } = await import("../src/storage/migrations.js");
    runMigrations(db);

    const row = db.prepare(`SELECT ingest_status, ingest_error, ingest_attempts FROM traces LIMIT 1`).get() as { ingest_status: string; ingest_error: string | null; ingest_attempts: number };
    expect(row.ingest_status).toBe("ok");
    expect(row.ingest_error).toBeNull();
    expect(row.ingest_attempts).toBe(0);
    db.close();
  });
});
