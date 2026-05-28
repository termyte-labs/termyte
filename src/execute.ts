import { spawnSync } from "node:child_process";
import type { ExecutionOutcome, ShellFlavor } from "./types.js";

function powershellExecutable(): string {
  return process.platform === "win32" ? "powershell.exe" : "pwsh";
}

function cmdExecutable(): string {
  return process.platform === "win32" ? "cmd.exe" : "sh";
}

export function executeCommand(command: string, shell: ShellFlavor, cwd: string): ExecutionOutcome {
  const start = Date.now();

  try {
    const result =
        shell === "powershell"
        ? spawnSync(powershellExecutable(), ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", cwd })
        : shell === "cmd"
          ? spawnSync(cmdExecutable(), process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], {
              encoding: "utf8",
              cwd,
            })
          : spawnSync(cmdExecutable(), process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command], {
              encoding: "utf8",
              cwd,
            });

    return {
      status: result.status === null ? "failed" : result.status === 0 ? "executed" : "failed",
      exitCode: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      durationMs: Date.now() - start,
      errorMessage: result.error?.message,
    };
  } catch (error) {
    return {
      status: "failed",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: Date.now() - start,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
