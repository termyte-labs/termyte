import { existsSync, readFileSync, writeFileSync } from "node:fs";

/** Match both packaged hook.js commands and legacy termyte-hook binaries. */
export function isTermyteHookCommand(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /termyte-hook\b|(?:hook\.js|hook\.ts)["']?\s+(?:claude-code|codex)\b/i.test(command);
}

export function removeTermyteHookEntries(path: string): boolean {
  if (!existsSync(path)) return false;
  let parsed: any;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return false; }
  if (!parsed.hooks || typeof parsed.hooks !== "object") return false;
  let changed = false;
  for (const [event, groups] of Object.entries(parsed.hooks)) {
    if (!Array.isArray(groups)) continue;
    const filtered = groups.filter((group: any) =>
      !Array.isArray(group?.hooks) || !group.hooks.some((hook: any) => isTermyteHookCommand(hook?.command)),
    );
    if (filtered.length !== groups.length) changed = true;
    if (filtered.length === 0) delete parsed.hooks[event];
    else parsed.hooks[event] = filtered;
  }
  if (changed) writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  return changed;
}
