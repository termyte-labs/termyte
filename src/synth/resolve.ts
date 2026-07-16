/**
 * Resolve the absolute path to an agent's binary, or null if not
 * found. Checks an env-var override first, then PATH / standard install locations.
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
  if (cache.has(name)) {
    const cached = cache.get(name) ?? null;
    if (cached && existsSync(cached)) return cached;
    cache.delete(name);
  }

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
    const first = pickBestCandidate(stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    if (first && existsSync(first)) {
      const resolved = first;
      cache.set(name, resolved);
      return resolved;
    }
  } catch {
    // not found
  }
  cache.set(name, null);
  return null;
}

function pickBestCandidate(candidates: string[]): string | null {
  if (candidates.length === 0) return null;
  if (process.platform !== "win32") return candidates[0] ?? null;
  const preferred = candidates.find((c) => /\.(cmd|bat|exe)$/i.test(c));
  return preferred ?? candidates[0] ?? null;
}
