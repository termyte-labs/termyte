/**
 * Resolve the absolute path to the `termyte-hook` and `termyte-mcp` entry
 * scripts. These are baked into per-IDE config files (Cursor, Windsurf,
 * Gemini) because those hosts do no `${ENV}` substitution on the
 * `command` / `args` fields.
 *
 * Probes in order: TERMYTE_HOOK_PATH env, the directory above this file
 * (the `dist/cli/` folder when running from a build), then a few
 * common repo layouts.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function firstExisting(candidates: string[]): string | null {
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

/**
 * Resolve an installer path. If the env var is set, return it
 * unconditionally — installer config files bake whatever path you give
 * them, even if the target file doesn't exist yet (e.g. before the
 * first `npm run build`). Otherwise probe the candidates.
 */
function resolveWithEnv(envValue: string | undefined, candidates: string[]): string | null {
  if (envValue) return envValue;
  return firstExisting(candidates.filter((p): p is string => Boolean(p)));
}

/** Absolute path to `termyte-hook` (the same script as `dist/cli/hook.js`
 *  in a build, or the TS source path when running from source). */
export function getTermyteHookPath(): string | null {
  return resolveWithEnv(process.env.TERMYTE_HOOK_PATH, [
    join(here, "hook.js"),
    join(here, "hook.ts"),
    join(here, "..", "cli", "hook.js"),
    join(here, "..", "cli", "hook.ts"),
    join(process.cwd(), "dist", "cli", "hook.js"),
    join(process.cwd(), "src", "cli", "hook.ts"),
  ]);
}

/** Absolute path to `termyte-mcp` (the stdio MCP server). */
export function getTermyteMcpPath(): string | null {
  return resolveWithEnv(process.env.TERMYTE_MCP_PATH, [
    join(here, "mcp", "server.js"),
    join(here, "mcp", "server.ts"),
    join(here, "..", "mcp", "server.js"),
    join(here, "..", "mcp", "server.ts"),
    join(process.cwd(), "dist", "mcp", "server.js"),
    join(process.cwd(), "src", "mcp", "server.ts"),
  ]);
}

/** Path to the currently running Node executable — used by MCP-only
 *  integrations that need `node <mcp-server.js>` baked. */
export function getNodeAbsolutePath(): string {
  return process.execPath;
}

/** Replace any path separator backslashes in `p` with their escaped
 *  form, so a baked path is safe to embed inside a JSON string. */
export function jsonEscapePath(p: string): string {
  return p.replace(/\\/g, "\\\\");
}

/** Replace a path's separators so it survives an OS shell. */
export function shellEscapePath(p: string): string {
  return p.replace(/\\/g, "\\\\");
}

/** Walk up from `start` looking for the termyte project root (which
 *  contains `package.json` with `"name": "termyte"`). */
export function findTermyteProjectRoot(start: string = process.cwd()): string | null {
  let current = resolve(start);
  for (let i = 0; i < 6; i++) {
    const pkg = join(current, "package.json");
    if (existsSync(pkg)) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
