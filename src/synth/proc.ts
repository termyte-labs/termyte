/**
 * Cross-platform "is this PID still alive?" check. Used by the lock
 * file to detect stale locks.
 */
import { execSync } from "node:child_process";

export function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      return /\S/.test(out) && out.toLowerCase().includes(String(pid));
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
