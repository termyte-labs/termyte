/**
 * Synthesis lock file. Prevents two `termyte-synth` invocations from
 * running at the same time (e.g. SessionEnd fires while a manual
 * `termyte-synth --once` is still going). The lock is owned by
 * PID + start time; if the owning process is gone, the next caller
 * takes over.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isAlive } from "./proc.js";

export interface LockInfo {
  pid: number;
  startedAt: number;
  host: string;
}

export class LockBusyError extends Error {
  constructor(public readonly info: LockInfo) {
    super(`termyte-synth is already running (pid=${info.pid}, started=${new Date(info.startedAt).toISOString()})`);
    this.name = "LockBusyError";
  }
}

export class Lock {
  private released = false;
  constructor(private lockPath: string, public readonly info: LockInfo) {}

  /** Try to acquire a lock. Throws LockBusyError if another process
   *  holds it and is still alive. Stale locks (dead PID) are
   *  transparently taken. */
  static acquire(lockPath: string, info: LockInfo): Lock {
    mkdirSync(dirname(lockPath), { recursive: true });
    if (existsSync(lockPath)) {
      const existing = readLockFile(lockPath);
      if (existing && isAlive(existing.pid)) {
        throw new LockBusyError(existing);
      }
      // Stale: overwrite.
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
    writeFileSync(lockPath, JSON.stringify(info), "utf-8");
    return new Lock(lockPath, info);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try { unlinkSync(this.lockPath); } catch { /* ignore */ }
  }
}

function readLockFile(p: string): LockInfo | null {
  try {
    const raw = readFileSync(p, "utf-8");
    const parsed = JSON.parse(raw) as LockInfo;
    if (typeof parsed.pid === "number" && typeof parsed.startedAt === "number") {
      return parsed;
    }
    return null;
  } catch { return null; }
}
