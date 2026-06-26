/**
 * Gemini CLI adapter — invokes `gemini -p` with the synthesis prompt
 * and parses the JSON envelope.
 *
 * Documented (geminicli.com, 2026-06):
 *   gemini -p PROMPT [--output-format text|json|stream-json]
 *   --output-format json   single { response, stats, error? } object
 *
 * The free tier is 60 req/min and 1000 req/day — a hard constraint.
 * We rate-limit accordingly. The limit can be tuned via env vars.
 *
 * Reference: https://www.geminicli.com/docs/cli/headless
 */
import { spawn } from "node:child_process";
import { resolveBinaryPath } from "./resolve.js";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";
import { RateLimiter } from "./rate-limit.js";

const DEFAULT_MAX_PER_MIN = Number(process.env.TERMYTE_GEMINI_RPM ?? "50"); // safety margin under 60
const DEFAULT_MAX_PER_DAY = Number(process.env.TERMYTE_GEMINI_RPD ?? "900"); // safety margin under 1000
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

export class GeminiCliAdapter implements AgentAdapter {
  readonly id = "gemini-cli" as const;
  readonly displayName = "Gemini CLI";

  private perMinute = new RateLimiter({ maxRequests: DEFAULT_MAX_PER_MIN, windowMs: MINUTE_MS });
  private perDay = new RateLimiter({ maxRequests: DEFAULT_MAX_PER_DAY, windowMs: DAY_MS });
  private cachedAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    const path = await resolveBinaryPath("gemini", ["GEMINI_PATH"]);
    this.cachedAvailable = path !== null;
    return this.cachedAvailable;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const bin = await resolveBinaryPath("gemini", ["GEMINI_PATH"]);
    if (!bin) {
      throw new AgentInvocationError("not_available", "gemini CLI not found in PATH (set GEMINI_PATH)");
    }
    if (!this.perMinute.tryAcquire() || !this.perDay.tryAcquire()) {
      throw new AgentInvocationError("rate_limited",
        `gemini rate limit reached (${this.perMinute.remaining()}/min, ${this.perDay.remaining()}/day remaining)`);
    }
    return runGemini(bin, prompt, opts ?? {});
  }

  /** Test-only: replace the rate limiters with smaller ones. */
  __setRateLimits(perMinute: number, perDay: number): void {
    this.perMinute = new RateLimiter({ maxRequests: perMinute, windowMs: MINUTE_MS });
    this.perDay = new RateLimiter({ maxRequests: perDay, windowMs: DAY_MS });
  }
}

interface GeminiJsonResponse {
  response?: string;
  stats?: { input_tokens?: number; output_tokens?: number; model?: string };
  error?: { message?: string; type?: string };
}

async function runGemini(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const args = ["-p", prompt, "--output-format", "json"];
  if (opts.cwd) args.push("--include-directories", opts.cwd);

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
  // Gemini CLI reads the prompt via -p; no stdin needed.

  const exitCode: number = await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AgentInvocationError("timeout", `gemini -p exceeded ${opts.timeoutMs}ms`));
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
    if (stderr.toLowerCase().includes("rate limit") || stderr.includes("429") || stderr.includes("RESOURCE_EXHAUSTED")) {
      throw new AgentInvocationError("rate_limited", stderr.trim() || "rate limited", stderr);
    }
    throw new AgentInvocationError("non_zero_exit", `gemini -p exited ${exitCode}`, stderr);
  }

  const parsed = parseGeminiJson(stdout);
  if (parsed.error?.message) {
    throw new AgentInvocationError("internal", parsed.error.message, stderr);
  }
  const text = parsed.response ?? "";
  if (!text) {
    throw new AgentInvocationError("invalid_output", "gemini -p returned no response field", stderr);
  }
  return {
    text,
    json: safeJson(text),
    model: parsed.stats?.model,
    usage: { input: parsed.stats?.input_tokens, output: parsed.stats?.output_tokens },
    durationMs: Date.now() - startedAt,
  };
}

function parseGeminiJson(raw: string): GeminiJsonResponse {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try { return JSON.parse(trimmed) as GeminiJsonResponse; }
  catch { return {}; }
}

function safeJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1]!); } catch { /* fallthrough */ } }
  try { return JSON.parse(text); } catch { return null; }
}
