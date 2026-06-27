/**
 * Shared installer helpers.
 *
 * `backupIfExists(p)` writes a `.bak.<timestamp>` copy of `p` if it
 * exists and is not already a backup. Returns the backup path or
 * null. Used by every installer that overwrites a user-owned file —
 * silently clobbering a corrupted or hand-edited config is a data-loss
 * bug.
 */
import { copyFileSync, existsSync } from "node:fs";

export function backupIfExists(p: string): string | null {
  if (!existsSync(p)) return null;
  // Don't back up a previous backup.
  if (/\.bak\.\d+$/.test(p)) return null;
  const stamp = Date.now();
  const backup = `${p}.bak.${stamp}`;
  try {
    copyFileSync(p, backup);
    return backup;
  } catch {
    return null;
  }
}
