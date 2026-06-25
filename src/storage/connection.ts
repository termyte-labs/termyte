import Database from "better-sqlite3";

export type DB = Database.Database;

export interface DatabaseContext {
  db: DB;
  dbPath: string;
}

export function defaultDbPath(): string {
  return process.env.TERMYTE_DB ?? "./termyte.db";
}

export function openDatabase(dbPath: string = defaultDbPath()): DatabaseContext {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return { db, dbPath };
}

export function closeDatabase(ctx: DatabaseContext): void {
  ctx.db.close();
}
