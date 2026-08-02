#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { HookRunner } from "../agents/hooks/runner.js";
import { ContextBuilder } from "../context/builder.js";
import { adapterFor } from "../capture/index.js";
import type { Platform } from "../shared/types.js";

const PLATFORMS: Platform[] = ["claude-code", "codex"];

async function main(): Promise<void> {
  if (process.env.TERMYTE_INTERNAL_SYNTHESIS === "1") return;
  const platform = process.argv[2] as Platform | undefined;
  const action = process.argv[3] ?? "capture";
  if (!platform || !PLATFORMS.includes(platform)) throw new Error("usage: termyte-hook <claude-code|codex> <session-init|recall|capture>");
  const raw = await readStdin();
  if (!raw.trim()) return;
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const event = await new HookRunner(store).processRaw(platform, JSON.parse(raw));
    if (!event) return;
    const session = store.getSession(event.session_id);
    if (!session?.repo_id || !session.workspace_root) return;
    const builder = new ContextBuilder(store);
    let additionalContext = "";
    let hookEventName = "";
    if (action === "session-init" && event.event_type === "session_init") {
      const handoff = await builder.buildSessionHandoff({ repoId: session.repo_id, sessionId: session.session_id, workspaceRoot: session.workspace_root });
      if (handoff) {
        hookEventName = "SessionStart";
        additionalContext = `This is the verified handoff from the previous session. In your first response, naturally show awareness of it and continue from the stated next step without asking the developer to repeat it.\n\n${handoff.content}`;
      }
    } else if (action === "recall" && event.event_type === "user_prompt" && shouldRecall(event.user_prompt)) {
      const matches = builder.recall(session.repo_id, event.user_prompt ?? "");
      if (matches.length > 0) {
        hookEventName = "UserPromptSubmit";
        additionalContext = `Relevant prior session context:\n\n${matches.map((item) => item.content).join("\n\n---\n\n")}`;
      }
    }
    if (additionalContext) {
      const output = adapterFor(platform).formatOutput({ continue: true, hookSpecificOutput: { hookEventName, additionalContext } });
      process.stdout.write(`${JSON.stringify(output)}\n`);
    }
  } finally { store.close(); }
}

function shouldRecall(prompt: string | null): boolean {
  return /\b(?:why|previous|before|last time|what did|what happened|tried|chose|chosen|decision)\b/i.test(prompt ?? "");
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
if (isMain()) void main().catch((error) => { process.stderr.write(`termyte-hook: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
