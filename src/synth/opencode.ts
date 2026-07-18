import { spawn } from "node:child_process";
import { resolveBinaryPath } from "./resolve.js";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";

  private cachedAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    const path = await resolveBinaryPath("opencode", ["OPENCODE_PATH"]);
    this.cachedAvailable = path !== null;
    return this.cachedAvailable;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const bin = await resolveBinaryPath("opencode", ["OPENCODE_PATH"]);
    if (!bin) throw new AgentInvocationError("not_available", "opencode CLI not found in PATH (set OPENCODE_PATH)");
    return runOpenCode(bin, prompt, opts ?? {});
  }
}

interface OpenCodeEvent {
  type?: string;
  part?: { type?: string; text?: string };
  error?: unknown;
}

async function runOpenCode(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const startedAt = Date.now();
  const isWindowsCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  const child = spawn(bin, ["run", "--format", "json", prompt], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: isWindowsCmd,
    cwd: opts.cwd,
    env: { ...process.env, TERMYTE_INTERNAL_SYNTHESIS: "1" },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf-8"); });

  const abort = opts.signal;
  if (abort?.aborted) {
    child.kill();
    throw new AgentInvocationError("cancelled", "synthesis cancelled before start");
  }
  abort?.addEventListener("abort", () => { child.kill(); }, { once: true });

  const exitCode: number = await new Promise((resolve, reject) => {
    const timer = opts.timeoutMs && opts.timeoutMs > 0
      ? setTimeout(() => {
        child.kill();
        reject(new AgentInvocationError("timeout", `opencode run exceeded ${opts.timeoutMs}ms`));
      }, opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve(code ?? 0);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
  });

  if (exitCode !== 0) {
    if (abort?.aborted) throw new AgentInvocationError("cancelled", "synthesis cancelled");
    if (/rate limit|429/i.test(stderr)) throw new AgentInvocationError("rate_limited", stderr.trim() || "rate limited", stderr);
    throw new AgentInvocationError("non_zero_exit", `opencode run exited ${exitCode}`, stderr);
  }

  const events = stdout.split(/\r?\n/).flatMap((line): OpenCodeEvent[] => {
    try { return line.trim() ? [JSON.parse(line) as OpenCodeEvent] : []; }
    catch { return []; }
  });
  const error = events.find((event) => event.type === "error");
  if (error) throw new AgentInvocationError("internal", `opencode run returned an error: ${JSON.stringify(error.error ?? error)}`, stderr);
  const text = events
    .filter((event) => event.type === "text" && event.part?.type === "text" && event.part.text)
    .map((event) => event.part!.text!)
    .join("\n");
  if (!text) throw new AgentInvocationError("invalid_output", "opencode run did not emit a text event", stderr);

  return { text, json: safeJson(text), durationMs: Date.now() - startedAt };
}

function safeJson(text: string): unknown | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) { try { return JSON.parse(fence[1]!); } catch { /* fall through */ } }
  try { return JSON.parse(text); } catch { return null; }
}
