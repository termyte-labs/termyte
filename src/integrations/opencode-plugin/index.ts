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
 * sees the same NormalizedEvent shape. It does not fake context
 * injection; Termyte already exposes real context through the CLI and
 * MCP paths, and this plugin stays limited to capture forwarding.
 *
 * The plugin lives as a separate file (not imported by the CLI) so
 * OpenCode can `import` it without pulling in better-sqlite3 or any
 * of the LLM provider code.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

const CONTEXT_TAG_OPEN = "<!-- termyte:context:start -->";
const CONTEXT_TAG_CLOSE = "<!-- termyte:context:end -->";

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
 *  stdio JSON in and ignore the response. */
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

function resolveCliPath(): string | null {
  const hookPath = resolveHookPath();
  if (hookPath) {
    const candidate = hookPath.replace(/hook\.(js|ts)$/, "index.$1");
    if (existsSync(candidate)) return candidate;
    const parentCandidate = hookPath.replace(/hook\.(js|ts)$/, "../index.$1");
    if (existsSync(parentCandidate)) return parentCandidate;
  }
  const candidates = [
    join(process.cwd(), "dist", "cli", "index.js"),
    join(process.cwd(), "src", "cli", "index.ts"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function agentsMdPath(): string {
  return join(process.env.OPENCODE_CONFIG_DIR || join(process.env.HOME ?? process.cwd(), ".config", "opencode"), "AGENTS.md");
}

function sharedContextPath(worktree?: string): string {
  const root = worktree && worktree.length > 0 ? worktree : process.cwd();
  return join(root, ".termyte", "share", "context.md");
}

function renderContextBlock(content: string): string {
  return [
    "",
    CONTEXT_TAG_OPEN,
    "# Termyte Context",
    "",
    content.trim(),
    CONTEXT_TAG_CLOSE,
    "",
  ].join("\n");
}

function refreshContext(worktree?: string): void {
  const sharedPath = sharedContextPath(worktree);
  if (!existsSync(sharedPath)) {
    const cliPath = resolveCliPath();
    if (!cliPath) return;
    const cwd = worktree && worktree.length > 0 ? worktree : process.cwd();
    const res = spawnSync(process.execPath, [cliPath, "context", "--limit", "12", "--write-file", sharedPath], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (res.status !== 0 || !existsSync(sharedPath)) return;
  }

  const path = agentsMdPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const sharedText = readFileSync(sharedPath, "utf-8");
  if (!sharedText.trim()) return;
  const block = renderContextBlock(sharedText);
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
  let next = existing;
  if (existing.includes(CONTEXT_TAG_OPEN) && existing.includes(CONTEXT_TAG_CLOSE)) {
    next = existing.replace(new RegExp(`${escapeRegex(CONTEXT_TAG_OPEN)}[\\s\\S]*?${escapeRegex(CONTEXT_TAG_CLOSE)}\\n?`, "m"), block);
  } else {
    next = existing.length > 0 && !existing.endsWith("\n") ? existing + "\n" + block : existing + block;
  }
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
      refreshContext(_ctx.project?.worktree);
    }
  },
};

export default plugin;

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
