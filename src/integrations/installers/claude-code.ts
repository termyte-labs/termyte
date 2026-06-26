/**
 * Install termyte hooks for Claude Code.
 *
 * Claude Code reads `~/.claude/settings.json` (user-level) or
 * `<project>/.claude/settings.json` (project-level). The hooks
 * subsection maps event names to an array of command definitions.
 * Claude Code performs no path substitution on `command`, so we
 * bake the absolute path to `termyte-hook` at install time.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getTermyteHookPath, shellEscapePath } from "../install-paths.js";

interface ClaudeHookEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface ClaudeHooksGroup {
  matcher?: string;
  hooks: ClaudeHookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, ClaudeHooksGroup[]>;
  [k: string]: unknown;
}

const HOOK_EVENTS: Array<{ event: string; command: string; timeout: number }> = [
  { event: "SessionStart",      command: "session-init",  timeout: 60 },
  { event: "UserPromptSubmit",  command: "context",       timeout: 30 },
  { event: "PreToolUse",        command: "file-context",  timeout: 30 },
  { event: "PostToolUse",       command: "observation",   timeout: 60 },
  { event: "Stop",              command: "summarize",     timeout: 60 },
];

export interface ClaudeInstallOptions {
  target: "user" | "project";
  /** Override `os.homedir()` for tests. Defaults to `homedir()`. */
  homeDir?: string;
}

export function installClaudeCodeHooks(opts: ClaudeInstallOptions): number {
  const hookPath = getTermyteHookPath();
  if (!hookPath) {
    process.stderr.write("termyte: could not locate the termyte-hook entry script.\n");
    process.stderr.write("  Set TERMYTE_HOOK_PATH or run from a built dist/.\n");
    return 1;
  }

  const home = opts.homeDir ?? homedir();
  const settingsPath = opts.target === "user"
    ? join(home, ".claude", "settings.json")
    : join(process.cwd(), ".claude", "settings.json");

  const existing: ClaudeSettings = existsSync(settingsPath)
    ? safeReadJson(settingsPath)
    : {};

  if (!existing.hooks) existing.hooks = {};

  const escaped = shellEscapePath(hookPath);
  for (const e of HOOK_EVENTS) {
    const cmd = `node "${escaped}" claude-code ${e.command}`;
    const group: ClaudeHooksGroup = {
      matcher: "*",
      hooks: [{ type: "command", command: cmd, timeout: e.timeout * 1000 }],
    };
    const list = existing.hooks[e.event] ?? [];
    const filtered = list.filter((g) => !g.hooks.some((h) => h.command.includes("termyte-hook")));
    existing.hooks[e.event] = [...filtered, group];
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  process.stdout.write(`termyte: wrote Claude Code hooks to ${settingsPath}\n`);
  process.stdout.write(`termyte: synthesis will run automatically on session end (uses 'claude -p' in the background).\n`);
  process.stdout.write(`termyte: run 'termyte synth --dry-run' to preview what would be sent.\n`);
  return 0;
}

function safeReadJson(p: string): ClaudeSettings {
  try { return JSON.parse(readFileSync(p, "utf-8")) as ClaudeSettings; }
  catch { return {}; }
}
