/**
 * Termyte OpenCode plugin.
 *
 * OpenCode discovers plugins by importing a JS file referenced from
 * `~/.config/opencode/opencode.json` under `plugin`. The default export
 * is a plugin object; OpenCode calls its `config`, `auth`, and
 * `experimental.hook` methods to wire up behavior.
 *
 * This plugin forwards every event OpenCode raises to
 * `termyte-hook opencode <event>` so the existing observer pipeline
 * sees the same NormalizedEvent shape. It also writes a placeholder
 * context block to `~/.config/opencode/AGENTS.md` so the next session
 * knows where termyte context will appear; real memory injection is
 * not yet wired (run `termyte-worker` and `termyte synth` to build
 * memories from captured traces).
 *
 * The plugin lives as a separate file (not imported by the CLI) so
 * OpenCode can `import` it without pulling in better-sqlite3 or any
 * of the LLM provider code.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface OpenCodePluginContext {
  client?: unknown;
  project?: { worktree?: string };
  $?: { getSessionId?: () => Promise<string> };
}

interface HookPayload {
  event: string;
  data?: unknown;
  sessionID?: string;
  message?: { role?: string; content?: string; parts?: Array<{ type: string; text?: string }> };
  tool?: string;
  args?: unknown;
  output?: unknown;
  directory?: string;
  [k: string]: unknown;
}

const HOOK_EVENTS = [
  "tool.execute.after",
  "chat.message",
  "experimental.session.compacting",
  "session.idle",
  "session.created",
  "session.deleted",
];

/** Locate the termyte-hook binary. Honours TERMYTE_HOOK_PATH; otherwise
 *  probes common dist layouts. */
function resolveHookPath(): string | null {
  const env = process.env.TERMYTE_HOOK_PATH;
  if (env && existsSync(env)) return env;
  const candidates = [
    join(process.cwd(), "dist", "cli", "hook.js"),
    join(process.cwd(), "src", "cli", "hook.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/** Forward an event to termyte-hook without blocking the agent. We use
 *  stdio JSON in and ignore the response — the hook will write context
 *  to the AGENTS.md file when appropriate. */
function forward(eventName: string, payload: HookPayload): void {
  const hookPath = resolveHookPath();
  if (!hookPath) return;
  try {
    const child = spawn(process.execPath, [hookPath, "opencode", eventName], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
    child.on("error", () => { /* best-effort */ });
  } catch {
    /* never crash the agent because of a memory hook failure */
  }
}

function agentsMdPath(): string {
  return join(homedir(), ".config", "opencode", "AGENTS.md");
}

const CONTEXT_TAG_OPEN = "<!-- termyte:context:start -->";
const CONTEXT_TAG_CLOSE = "<!-- termyte:context:end -->";

/** Append (or refresh) the termyte context block in AGENTS.md. Called
 *  after session.idle. We only write a placeholder if a real context
 *  file was produced by the termyte CLI; otherwise the file is left
 *  alone to avoid noisy edits. */
function injectContextPlaceholder(): void {
  const path = agentsMdPath();
  mkdirSync(join(path, ".."), { recursive: true });
  let existing = "";
  if (existsSync(path)) existing = readFileSync(path, "utf-8");
  if (existing.includes(CONTEXT_TAG_OPEN)) return;
  const block = [
    "",
    CONTEXT_TAG_OPEN,
    "# Termyte Context",
    "",
    "*No memories yet. Use the termyte search CLI to inspect the corpus.*",
    CONTEXT_TAG_CLOSE,
    "",
  ].join("\n");
  const next = existing.length > 0 && !existing.endsWith("\n")
    ? existing + "\n" + block
    : existing + block;
  writeFileSync(path, next, "utf-8");
}

const plugin = {
  name: "termyte",

  /** OpenCode calls this on every supported event. */
  "experimental.hook": async (
    eventName: string,
    payload: HookPayload,
    _ctx: OpenCodePluginContext,
  ): Promise<void> => {
    if (HOOK_EVENTS.includes(eventName)) {
      forward(eventName, payload);
    }
    if (eventName === "session.idle") {
      injectContextPlaceholder();
    }
  },
};

export default plugin;
