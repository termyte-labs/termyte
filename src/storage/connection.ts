import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type DB = Database.Database;

export interface DatabaseContext {
  db: DB;
  dbPath: string;
}

export function defaultDbPath(): string {
  if (process.env.TERMYTE_DB) return process.env.TERMYTE_DB;
  const home = process.env.TERMYTE_HOME;
  return home ? join(home, "termyte.db") : join(homedir(), ".termyte", "termyte.db");
}

export function openDatabase(dbPath: string = defaultDbPath()): DatabaseContext {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return { db, dbPath };
}

export function closeDatabase(ctx: DatabaseContext): void {
  ctx.db.close();
}
