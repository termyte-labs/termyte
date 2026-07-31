/**
 * Worker supervision — the mechanism that lets an installed hook record a
 * trace and have the durable pipeline drain it without a manually invoked
 * worker and without blocking the agent.
 *
 * Model: when `termyte-hook` ingests a trace it enqueues an
 * `extract_observation` job. The hook then asks a `WorkerSupervisor` to
 * maybe launch `termyte-worker --until-idle` as a detached, unref'd child
 * process. The worker drains the durable queue and exits when idle.
 *
 * To avoid spawning a herd of workers on every hook event, the worker
 * holds a single-instance lockfile keyed on the database path. Redundant
 * spawns check the lock and exit immediately if a worker is already
 * draining that database.
 *
 * The hook never blocks on enrichment; the spawn is detached and unref'd.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A supervisor decides whether to launch a worker and does so. */
export interface WorkerSupervisor {
  /** Launch a worker if appropriate. Returns true if a launch was initiated. */
  maybeLaunch(): boolean;
}

export interface DetachedSupervisorConfig {
  /** Path to the SQLite database the worker should drain. */
  dbPath: string;
  /** Absolute path to the worker entry script (e.g. dist/cli/worker.js). */
  workerPath: string;
  /** Node executable, defaults to the current process. */
  nodeExecutable?: string;
  /** When false, the supervisor never launches (used for tests / opt-out). */
  enabled: boolean;
  /** Extra env for the spawned worker; TERMYTE_DB is always set. */
  env?: NodeJS.ProcessEnv;
}

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the worker entry path. Honours `TERMYTE_WORKER_PATH`; otherwise
 * probes the built dist layout and the source checkout so the supervisor
 * works both from an installed package and from a dev checkout.
 */
export function resolveWorkerPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.TERMYTE_WORKER_PATH;
  if (override && existsSync(override)) return override;
  const candidates = [
    join(here, "worker.js"),
    join(here, "..", "cli", "worker.js"),
    join(process.cwd(), "dist", "cli", "worker.js"),
    join(process.cwd(), "src", "cli", "worker.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Default supervisor: spawns a detached worker process. */
export class DetachedWorkerSupervisor implements WorkerSupervisor {
  private readonly cfg: DetachedSupervisorConfig;

  constructor(cfg: DetachedSupervisorConfig) {
    this.cfg = cfg;
  }

  maybeLaunch(): boolean {
    if (!this.cfg.enabled) return false;
    if (isWorkerRunning(this.cfg.dbPath)) return false;
    const childEnv = { ...this.cfg.env, ...process.env, TERMYTE_DB: this.cfg.dbPath };
    try {
      const child = spawn(
        this.cfg.nodeExecutable ?? process.execPath,
        [this.cfg.workerPath, "--until-idle", "--supervised"],
        {
          stdio: "ignore",
          detached: true,
          env: childEnv,
          windowsHide: true,
        },
      );
      // Detach so the hook process can exit without waiting for the worker.
      child.unref();
      return true;
    } catch {
      // Never let supervision failures break the agent hook.
      return false;
    }
  }
}

/** A supervisor that drains the queue in-process. Used by tests and any
 *  caller that wants synchronous draining instead of a detached process. */
export class RecordingWorkerSupervisor implements WorkerSupervisor {
  private launches = 0;
  private readonly onLaunch?: () => void;

  constructor(onLaunch?: () => void) {
    this.onLaunch = onLaunch;
  }

  maybeLaunch(): boolean {
    this.launches++;
    this.onLaunch?.();
    return true;
  }

  get launchCount(): number {
    return this.launches;
  }
}

// --- single-instance lockfile ------------------------------------------------

function lockPath(dbPath: string): string {
  return resolve(dbPath + ".worker.lock");
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Returns true if a live worker holds the lock for this database. */
export function isWorkerRunning(dbPath: string): boolean {
  const path = lockPath(dbPath);
  if (!existsSync(path)) return false;
  try {
    const payload = readLock(path);
    return payload != null && pidAlive(payload.pid);
  } catch {
    return false;
  }
}

interface LockPayload {
  pid: number;
  startedAt: number;
}

function readLock(path: string): LockPayload | null {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<LockPayload>;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
    // corrupt or unreadable
  }
  return null;
}

function writeLock(path: string, pid: number): void {
  writeFileSync(path, JSON.stringify({ pid, startedAt: Date.now() }, null, 2), "utf-8");
}

/**
 * Try to acquire the single-instance worker lock for `dbPath`. Returns true
 * if this caller now holds the lock. A stale lock whose PID is no longer
 * alive is taken over. Callers must release the lock on exit.
 */
export function acquireWorkerLock(dbPath: string, pid: number = process.pid): boolean {
  const path = lockPath(dbPath);
  try {
    const fd = openSync(path, "wx");
    closeSync(fd);
    writeLock(path, pid);
    return true;
  } catch {
    // Lock exists — take over only if the holder is dead.
    const payload = readLock(path);
    if (payload == null || !pidAlive(payload.pid)) {
      try {
        unlinkSync(path);
      } catch {
        return false;
      }
      try {
        const fd = openSync(path, "wx");
        closeSync(fd);
        writeLock(path, pid);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/** Release the single-instance worker lock if held. */
export function releaseWorkerLock(dbPath: string): void {
  const path = lockPath(dbPath);
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Build the default supervisor for the hook entry point. Returns null when
 *  the worker binary cannot be located or supervision is disabled. */
export function createHookSupervisor(
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerSupervisor {
  const enabled = env.TERMYTE_AUTO_WORKER !== "0" && env.TERMYTE_AUTO_WORKER !== "false";
  const fallback = new (class implements WorkerSupervisor {
    maybeLaunch(): boolean {
      return false;
    }
  })();
  if (!enabled) return fallback;
  const workerPath = resolveWorkerPath(env);
  if (!workerPath) return fallback;
  return new DetachedWorkerSupervisor({ dbPath, workerPath, enabled: true, env });
}
