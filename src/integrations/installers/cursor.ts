/**
 * Install termyte hooks for Cursor.
 *
 * Cursor reads `~/.cursor/hooks.json` (user-level) or
 * `<project>/.cursor/hooks.json` (project-level). It has five named
 * hook events: beforeSubmitPrompt, afterMCPExecution,
 * afterShellExecution, afterFileEdit, stop.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTermyteHookPath, shellEscapePath } from "../install-paths.js";
import type { CursorHooksJson, CursorInstallTarget } from "../types.js";

export function installCursorHooks(target: CursorInstallTarget, homeDirOverride?: string): number {
  const hookPath = getTermyteHookPath();
  if (!hookPath) {
    process.stderr.write("termyte: could not locate the termyte-hook entry script.\n");
    return 1;
  }

  const targetDir = cursorDir(target, homeDirOverride);
  if (!targetDir) {
    process.stderr.write(`termyte: invalid target '${target}'. Use: project, user, enterprise.\n`);
    return 1;
  }
  const hooksPath = join(targetDir, "hooks.json");

  const escaped = shellEscapePath(hookPath);
  const baseCmd = (event: string) => `node "${escaped}" cursor ${event}`;

  const existing: CursorHooksJson = existsSync(hooksPath)
    ? safeReadJson(hooksPath)
    : { version: 1, hooks: {} };
  if (!existing.hooks) existing.hooks = {};
  if (existing.version === undefined) existing.version = 1;

  const setHook = (event: keyof CursorHooksJson["hooks"], cmd: string) => {
    const list = existing.hooks[event] ?? [];
    const filtered = list.filter((h) => !h.command.includes("termyte-hook"));
    existing.hooks[event] = [...filtered, { command: cmd }];
  };

  setHook("beforeSubmitPrompt", baseCmd("context"));
  setHook("afterMCPExecution",  baseCmd("observation"));
  setHook("afterShellExecution", baseCmd("observation"));
  setHook("afterFileEdit",      baseCmd("file-edit"));
  setHook("stop",               baseCmd("summarize"));

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(hooksPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote Cursor hooks to ${hooksPath}\n`);
  process.stdout.write(`termyte: note — Cursor hooks cannot trigger the agent, so memory synthesis is not automatic for Cursor. Run 'termyte synth' from cron or a launcher to synthesize traces.\n`);
  return 0;
}

function cursorDir(target: CursorInstallTarget, homeDirOverride?: string): string | null {
  const home = homeDirOverride ?? homedir();
  if (target === "project") return join(process.cwd(), ".cursor");
  if (target === "user") return join(home, ".cursor");
  if (target === "enterprise") {
    if (process.platform === "darwin") return "/Library/Application Support/Cursor";
    if (process.platform === "linux") return "/etc/cursor";
    if (process.platform === "win32") {
      const pd = process.env.ProgramData || "C:\\ProgramData";
      return join(pd, "Cursor");
    }
    return null;
  }
  return null;
}

function safeReadJson(p: string): CursorHooksJson {
  try { return JSON.parse(readFileSync(p, "utf-8")) as CursorHooksJson; }
  catch { return { version: 1, hooks: {} }; }
}
