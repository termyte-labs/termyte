/**
 * Codex (OpenAI) adapter — invokes `codex exec` with the prompt on
 * stdin and parses the JSONL event stream.
 *
 * Documented flags (OpenAI, 2026-06):
 *   codex exec [OPTIONS] [PROMPT]
 *   --ephemeral        no session persistence
 *   --json             emit JSONL events to stdout
 *   --output-schema    validate final agent_message against a JSON Schema
 *   -o, --output-last-message <path>
 *   --sandbox          read-only | workspace-write | danger-full-access
 *
 * Reference: https://developers.openai.com/codex/noninteractive
 */
import { spawn } from "node:child_process";
import { resolveBinaryPath } from "./resolve.js";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";

export class CodexAdapter implements AgentAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";

  private cachedAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    const path = await resolveBinaryPath("codex", ["CODEX_PATH"]);
    this.cachedAvailable = path !== null;
    return this.cachedAvailable;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const bin = await resolveBinaryPath("codex", ["CODEX_PATH"]);
    if (!bin) {
      throw new AgentInvocationError("not_available", "codex CLI not found in PATH (set CODEX_PATH)");
    }
    return runCodex(bin, prompt, opts ?? {});
  }
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: { type: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number; cached_input_tokens?: number };
  error?: { message?: string };
}

async function runCodex(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const args: string[] = [
    "exec",
    "--ephemeral",
    "--sandbox", "read-only",
    "--json",
  ];
  if (opts.cwd) args.push("-C", opts.cwd);

  const startedAt = Date.now();
  const isWindowsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: isWindowsCmd,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });

  const abort = opts.signal;
  if (abort) {
    if (abort.aborted) {
      child.kill();
      throw new AgentInvocationError("cancelled", "synthesis cancelled before start");
    }
    abort.addEventListener("abort", () => { child.kill(); }, { once: true });
  }

  // Codex reads the prompt from stdin when no positional prompt is
  // given. We pass the prompt via stdin so multi-line content works
  // without shell-quoting issues.
  child.stdin.end(prompt, "utf-8");

  const exitCode: number = await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AgentInvocationError("timeout", `codex exec exceeded ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 0);
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
  });

  if (exitCode !== 0) {
    if (abort?.aborted) throw new AgentInvocationError("cancelled", "synthesis cancelled");
    if (stderr.toLowerCase().includes("rate limit") || stderr.includes("429")) {
      throw new AgentInvocationError("rate_limited", stderr.trim() || "rate limited", stderr);
    }
    throw new AgentInvocationError("non_zero_exit", `codex exec exited ${exitCode}`, stderr);
  }

  // Parse JSONL events. We want the last agent_message.
  const events: CodexEvent[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as CodexEvent); }
    catch { /* skip non-JSON lines */ }
  }

  let text = "";
  let usage: AgentInvokeResult["usage"];
  for (const ev of events) {
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
      text = ev.item.text;
    }
    if (ev.type === "turn.completed" && ev.usage) {
      usage = { input: ev.usage.input_tokens, output: ev.usage.output_tokens };
    }
  }

  if (!text) {
    // Some codex versions emit the final message as a top-level
    // {"type":"final","text":...}; we accept that too.
    const final = events.find((e) => e.type === "final") as unknown as { text?: string };
    if (final?.text) text = final.text;
  }

  if (!text) {
    throw new AgentInvocationError("invalid_output", "codex exec did not emit an agent_message", stderr);
  }

  return { text, json: safeJson(text), usage, durationMs: Date.now() - startedAt };
}

function safeJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1]!); } catch { /* fallthrough */ } }
  try { return JSON.parse(text); } catch { return null; }
}
