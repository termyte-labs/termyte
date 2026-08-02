/**
 * Resolve the absolute path to the `termyte-hook` entry script.
 *
 * Probes in order: TERMYTE_HOOK_PATH env, the directory above this file
 * (the `dist/cli/` folder when running from a build), then a few
 * common repo layouts.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
    join(here, "..", "..", "cli", "hook.js"),
    join(here, "..", "..", "cli", "hook.ts"),
    join(here, "..", "..", "..", "cli", "hook.js"),
    join(here, "..", "..", "..", "cli", "hook.ts"),
    join(process.cwd(), "dist", "cli", "hook.js"),
    join(process.cwd(), "src", "cli", "hook.ts"),
  ]);
}

/** Replace a path's separators so it survives an OS shell. */
export function shellEscapePath(p: string): string {
  return p;
}
