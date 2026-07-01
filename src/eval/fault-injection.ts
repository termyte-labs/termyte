import type { DB } from "../storage/connection.js";

export type FaultPoint =
  | "after_observation_insert"
  | "before_observation_embedding"
  | "after_observation_embedding"
  | "before_memory_insert"
  | "after_memory_insert"
  | "before_memory_embedding"
  | "after_memory_embedding";

export class InjectedFaultError extends Error {
  constructor(readonly point: FaultPoint, message = `Injected fault at ${point}`) {
    super(message);
    this.name = "InjectedFaultError";
  }
}

export class FaultInjector {
  private failOncePoints = new Set<FaultPoint>();
  private alwaysFailPoints = new Set<FaultPoint>();
  readonly hits: FaultPoint[] = [];

  failOnce(point: FaultPoint): void {
    this.failOncePoints.add(point);
  }

  alwaysFail(point: FaultPoint): void {
    this.alwaysFailPoints.add(point);
  }

  clear(point?: FaultPoint): void {
    if (point) {
      this.failOncePoints.delete(point);
      this.alwaysFailPoints.delete(point);
      return;
    }
    this.failOncePoints.clear();
    this.alwaysFailPoints.clear();
  }

  check(point: FaultPoint): void {
    this.hits.push(point);

    if (this.alwaysFailPoints.has(point)) {
      throw new InjectedFaultError(point);
    }

    if (this.failOncePoints.has(point)) {
      this.failOncePoints.delete(point);
      throw new InjectedFaultError(point);
    }
  }
}

export interface DurabilityInvariantReport {
  passed: boolean;
  violations: string[];
}

export function assertDurabilityInvariants(db: DB): DurabilityInvariantReport {
  const violations: string[] = [];

  if (hasTable(db, "observations") && hasColumn(db, "observations", "lifecycle_state")) {
    const rows = db.prepare(`
      SELECT id
      FROM observations
      WHERE lifecycle_state = 'indexed' AND embedding IS NULL
    `).all() as Array<{ id: number }>;

    for (const row of rows) {
      violations.push(`observation ${row.id} is indexed without an embedding`);
    }
  }

  if (hasTable(db, "memories") && hasColumn(db, "memories", "lifecycle_state")) {
    const rows = db.prepare(`
      SELECT id
      FROM memories
      WHERE lifecycle_state = 'active' AND embedding IS NULL
    `).all() as Array<{ id: number }>;

    for (const row of rows) {
      violations.push(`memory ${row.id} is active without an embedding`);
    }
  }

  return {
    passed: violations.length === 0,
    violations,
  };
}

function hasTable(db: DB, table: string): boolean {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type IN ('table', 'view') AND name = ?
  `).get(table);
  return Boolean(row);
}

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
