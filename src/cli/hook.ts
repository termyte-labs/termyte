#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { HookRunner } from "../agents/hooks/runner.js";
import { ContextBuilder } from "../context/builder.js";
import { adapterFor } from "../capture/index.js";
import type { Platform } from "../shared/types.js";
import { ExistingAgentClient } from "../llm/agent-client.js";

const PLATFORMS: Platform[] = ["claude-code", "codex"];

async function main(): Promise<void> {
  if (process.env.TERMYTE_INTERNAL_SYNTHESIS === "1") return;
  const platform = process.argv[2] as Platform | undefined;
  const action = process.argv[3] ?? "capture";
  if (!platform || !PLATFORMS.includes(platform)) throw new Error("usage: termyte-hook <claude-code|codex> <session-init|prompt-context|capture>");
  const raw = await readStdin();
  if (!raw.trim()) return;
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const event = await new HookRunner(store).processRaw(platform, JSON.parse(raw));
    if (!event) return;
    const session = store.getSession(event.session_id);
    if (!session?.repo_id || !session.workspace_root) return;
    const builder = new ContextBuilder(store, new ExistingAgentClient(config.agent), {
      briefingTokens: config.briefingTokenLimit,
      promptTokens: config.promptTokenLimit,
      catalogueTokens: config.catalogueTokenLimit,
      selectionTimeoutMs: config.selectionTimeoutMs,
    });
    let additionalContext = "";
    let hookEventName = "";
    if (action === "session-init" && event.event_type === "session_init") {
      hookEventName = "SessionStart";
      additionalContext = builder.buildProjectBriefing({ repoId: session.repo_id, sessionId: session.session_id, workspaceRoot: session.workspace_root });
    } else if ((action === "prompt-context" || action === "recall") && event.event_type === "user_prompt") {
      const briefing = builder.buildProjectBriefing({ repoId: session.repo_id, sessionId: session.session_id, workspaceRoot: session.workspace_root });
      const context = await builder.buildPromptContext({
        repoId: session.repo_id,
        sessionId: session.session_id,
        workspaceRoot: session.workspace_root,
        prompt: event.user_prompt ?? "",
        projectBriefing: briefing,
      });
      if (context) { hookEventName = "UserPromptSubmit"; additionalContext = context; }
    }
    if (additionalContext) {
      const output = adapterFor(platform).formatOutput({ continue: true, hookSpecificOutput: { hookEventName, additionalContext } });
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
    if ((event.event_type === "session_init" || event.event_type === "assistant_message" || event.event_type === "session_end")
      && store.hasRunnableReflectionJobs()) kickWorker(config.dbPath);
  } finally { store.close(); }
}

function kickWorker(dbPath: string): void {
  try {
    const workerPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    const child = spawn(process.execPath, [workerPath], {
      detached: true,
      cwd: dirname(dbPath),
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, TERMYTE_INTERNAL_SYNTHESIS: "1" },
    });
    child.unref();
  } catch { /* Reflection failure must never block the coding agent. */ }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function isMain(): boolean { try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; } }
if (isMain()) void main().catch((error) => {
  process.stderr.write(`termyte-hook: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 0;
});
