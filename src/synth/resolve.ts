/**
 * Resolve the absolute path to an agent's binary, or null if not
 * found. Checks an env-var override first, then PATH / standard
 * install locations.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const execFileP = promisify(execFile);

const cache = new Map<string, string | null>();

export async function resolveBinaryPath(
  name: string,
  envOverrides: string[] = [],
): Promise<string | null> {
  for (const envName of envOverrides) {
    const v = process.env[envName];
    if (v && existsSync(v)) {
      cache.set(name, v);
      return v;
    }
  }
  if (cache.has(name)) return cache.get(name) ?? null;

  // Common install locations per platform.
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(
      join(homedir(), ".local", "bin", `${name}.cmd`),
      join(homedir(), ".local", "bin", `${name}.exe`),
      join(homedir(), "AppData", "Roaming", "npm", `${name}.cmd`),
    );
  } else {
    candidates.push(
      join(homedir(), ".local", "bin", name),
      join(homedir(), ".bun", "bin", name),
      `/usr/local/bin/${name}`,
      `/opt/homebrew/bin/${name}`,
    );
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      cache.set(name, c);
      return c;
    }
  }

  // PATH lookup via `which` / `where`.
  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const { stdout } = await execFileP(cmd, [name], { windowsHide: true });
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first && existsSync(first.trim())) {
      const resolved = first.trim();
      cache.set(name, resolved);
      return resolved;
    }
  } catch {
    // not found
  }
  cache.set(name, null);
  return null;
}
