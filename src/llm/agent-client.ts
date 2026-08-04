import { spawn } from "node:child_process";
import type { Platform } from "../shared/types.js";

export interface AgentClient {
  complete(prompt: string, options?: { cwd?: string; timeoutMs?: number }): Promise<string>;
}

export class ExistingAgentClient implements AgentClient {
  constructor(private readonly platform: Platform, private readonly env: NodeJS.ProcessEnv = process.env) {}

  complete(prompt: string, options: { cwd?: string; timeoutMs?: number } = {}): Promise<string> {
    const command = this.platform === "codex"
      ? this.env.CODEX_PATH ?? "codex"
      : this.env.CLAUDE_PATH ?? "claude";
    const args = this.platform === "codex"
      ? ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"]
      : ["-p", "--safe-mode", "--no-session-persistence", "--tools", "", "--output-format", "text"];
    return run(command, args, prompt, {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 8_000,
      env: { ...this.env, TERMYTE_INTERNAL_SYNTHESIS: "1" },
    });
  }
}

function run(
  command: string,
  args: string[],
  input: string,
  options: { cwd?: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: process.platform === "win32" && (!/[\\/]/.test(command) || /\.(?:cmd|bat)$/i.test(command)),
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`agent timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `agent exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}
