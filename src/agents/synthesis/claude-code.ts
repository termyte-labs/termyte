/**
 * Claude Code adapter — invokes `claude -p` with the synthesis prompt
 * on stdin and parses the JSON output envelope.
 *
 * Documented flags (Anthropic, 2026-06):
 *   -p / --print       one-shot non-interactive prompt
 *   --output-format    json | text | stream-json
 *   --json-schema      validate output against JSON Schema
 *   --max-budget-usd   per-invocation cap
 *   --no-session-persistence  do not save session
 *   --bare             skip auto-discovery (faster startup)
 *
 * Reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference
 */
import { spawn } from "node:child_process";
import { resolveBinaryPath } from "./resolve.js";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id = "claude-code" as const;
  readonly displayName = "Claude Code";

  private cachedAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    const path = await resolveBinaryPath("claude", ["CLAUDE_PATH"]);
    this.cachedAvailable = path !== null;
    return this.cachedAvailable;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const bin = await resolveBinaryPath("claude", ["CLAUDE_PATH"]);
    if (!bin) {
      throw new AgentInvocationError("not_available", "claude CLI not found in PATH (set CLAUDE_PATH)");
    }
    return runClaude(bin, prompt, opts ?? {});
  }
}

interface ClaudeJsonResponse {
  type?: string;
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

async function runClaude(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const args: string[] = [
    "-p",
    "--no-session-persistence",
    "--bare",
    "--output-format", "json",
  ];
  if (opts.maxBudgetUsd && opts.maxBudgetUsd > 0) {
    args.push("--max-budget-usd", opts.maxBudgetUsd.toFixed(4));
  }

  const startedAt = Date.now();
  // On Windows, .cmd / .bat files require shell:true to be
  // executable. With shell:true the first element of `args` is
  // the binary path and the rest are CLI args.
  const isWindowsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, args, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: isWindowsCmd,
    cwd: opts.cwd,
    env: {
      ...process.env,
      CLAUDE_CODE_ENTRYPOINT: "cli",
      TERMYTE_INTERNAL_SYNTHESIS: "1",
    },
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
    abort.addEventListener("abort", () => {
      child.kill();
    }, { once: true });
  }

  child.stdin.end(prompt, "utf-8");

  const exitCode: number = await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AgentInvocationError("timeout", `claude -p exceeded ${opts.timeoutMs}ms`));
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
    if (stderr.toLowerCase().includes("rate limit") || stderr.toLowerCase().includes("429")) {
      throw new AgentInvocationError("rate_limited", stderr.trim() || "rate limited", stderr);
    }
    throw new AgentInvocationError("non_zero_exit", `claude -p exited ${exitCode}`, stderr);
  }

  const parsed = parseClaudeJson(stdout);
  if (parsed.is_error) {
    throw new AgentInvocationError("internal", parsed.result ?? "claude -p returned is_error=true", stderr);
  }

  return {
    text: parsed.result ?? "",
    json: parsed.result ? safeJson(parsed.result) : null,
    model: parsed.model,
    usage: {
      input: parsed.usage?.input_tokens,
      output: parsed.usage?.output_tokens,
    },
    durationMs: Date.now() - startedAt,
  };
}

function parseClaudeJson(raw: string): ClaudeJsonResponse {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed) as ClaudeJsonResponse; }
  catch { return {}; }
}

function safeJson(text: string): unknown | null {
  // Claude sometimes wraps the result in markdown fences. Try to
  // extract a JSON object from the text before returning.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) {
    try { return JSON.parse(fence[1]!); } catch { /* fallthrough */ }
  }
  try { return JSON.parse(text); } catch { return null; }
}
