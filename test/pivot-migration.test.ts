import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../src/storage/migrations.js";

describe("pivot migration", () => {
  it("upgrades the old trace event constraint without losing rows", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON");
    db.exec(`CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT UNIQUE NOT NULL, project TEXT NOT NULL, repo_id TEXT, workspace_root TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);
      CREATE TABLE traces (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, timestamp INTEGER NOT NULL, event_type TEXT NOT NULL CHECK(event_type IN ('session_init','user_prompt','tool_use','assistant_message','session_end')), tool_name TEXT, tool_input TEXT, tool_output TEXT, files_read TEXT, files_modified TEXT, user_prompt TEXT, final_response TEXT, processed_at INTEGER, FOREIGN KEY(session_id) REFERENCES sessions(session_id));
      INSERT INTO sessions(session_id, project, started_at) VALUES ('s1','demo',1);
      INSERT INTO traces(session_id,timestamp,event_type) VALUES ('s1',1,'session_init');`);
    runMigrations(db);
    db.prepare(`INSERT INTO traces(session_id,timestamp,event_type) VALUES ('s1',2,'compaction')`).run();
    expect((db.prepare(`SELECT COUNT(*) AS n FROM traces`).get() as { n: number }).n).toBe(2);
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });
});