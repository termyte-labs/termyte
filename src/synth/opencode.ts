/**
 * OpenCode adapter — prefers the `opencode serve` HTTP API
 * (`POST /session/:id/prompt`) and falls back to the `opencode run`
 * CLI when no server is reachable.
 *
 * Documented (opencode.ai, 2026-06):
 *   opencode serve [--port 4096]
 *   opencode run [--attach URL] [--format json] [PROMPT]
 *   POST /session/{id}/message          body: parts: [{type:"text",text}]
 *
 * References:
 *   https://opencode.ai/docs/cli
 *   https://opencode.ai/docs/server
 */
import { spawn } from "node:child_process";
import { resolveBinaryPath } from "./resolve.js";
import type { AgentAdapter, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";

const DEFAULT_OPENCODE_URL = "http://127.0.0.1:4096";
const OPENCODE_URL_ENV = "OPENCODE_URL";

export class OpenCodeAdapter implements AgentAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";

  private cachedAvailable: boolean | null = null;

  async isAvailable(): Promise<boolean> {
    if (this.cachedAvailable !== null) return this.cachedAvailable;
    if (await pingServer(getServerUrl())) {
      this.cachedAvailable = true;
      return true;
    }
    const path = await resolveBinaryPath("opencode", ["OPENCODE_PATH"]);
    this.cachedAvailable = path !== null;
    return this.cachedAvailable;
  }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    const serverUrl = getServerUrl();
    if (await pingServer(serverUrl)) {
      return runOpenCodeServer(serverUrl, prompt, opts ?? {});
    }
    const bin = await resolveBinaryPath("opencode", ["OPENCODE_PATH"]);
    if (!bin) {
      throw new AgentInvocationError("not_available", "opencode CLI not found and no server reachable");
    }
    return runOpenCodeCli(bin, prompt, opts ?? {});
  }
}

function getServerUrl(): string {
  return process.env[OPENCODE_URL_ENV] ?? DEFAULT_OPENCODE_URL;
}

async function pingServer(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/session`, { method: "GET" });
    return res.ok;
  } catch { return false; }
}

async function runOpenCodeServer(url: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const baseUrl = url.replace(/\/$/, "");
  const startedAt = Date.now();
  // Create a session, then send the prompt.
  const createRes = await fetch(`${baseUrl}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "termyte-synth" }),
  });
  if (!createRes.ok) {
    throw new AgentInvocationError("internal", `opencode POST /session failed: ${createRes.status} ${createRes.statusText}`);
  }
  const session = await createRes.json() as { id?: string };
  if (!session.id) {
    throw new AgentInvocationError("invalid_output", "opencode did not return a session id");
  }

  const sendRes = await fetch(`${baseUrl}/session/${session.id}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
  });
  if (!sendRes.ok) {
    throw new AgentInvocationError("internal", `opencode POST /message failed: ${sendRes.status} ${sendRes.statusText}`);
  }
  const data = await sendRes.json() as { parts?: Array<{ type: string; text?: string }> };
  const text = (data.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
  if (!text) {
    throw new AgentInvocationError("invalid_output", "opencode returned no text parts");
  }
  return { text, json: safeJson(text), durationMs: Date.now() - startedAt };
}

async function runOpenCodeCli(bin: string, prompt: string, opts: AgentInvokeOptions): Promise<AgentInvokeResult> {
  const args = ["run", "--format", "json"];
  if (opts.cwd) args.push("--dir", opts.cwd);

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

  child.stdin.end(prompt, "utf-8");

  const exitCode: number = await new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill();
        reject(new AgentInvocationError("timeout", `opencode run exceeded ${opts.timeoutMs}ms`));
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
    throw new AgentInvocationError("non_zero_exit", `opencode run exited ${exitCode}`, stderr);
  }

  return { text: stdout.trim(), json: safeJson(stdout), durationMs: Date.now() - startedAt };
}

function safeJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}
