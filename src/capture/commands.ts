import { execSync } from "node:child_process";
import type { CaptureEngine } from "./index.js";
import { redactSecrets } from "../utils.js";

export interface RunCommandOptions {
  cwd?: string;
  timeout?: number;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function runCommand(command: string, options: RunCommandOptions = {}): CommandResult {
  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: options.cwd ?? process.cwd(),
      encoding: "utf-8",
      timeout: options.timeout ?? 30_000,
      env: options.env ?? process.env,
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      durationMs: Date.now() - start,
    };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? "",
      durationMs: Date.now() - start,
    };
  }
}

export function recordCommandExecution(
  capture: CaptureEngine,
  sessionId: string,
  command: string,
  result: CommandResult,
): string {
  const event = capture.recordCommandEvent(sessionId, command, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: result.durationMs,
  });
  return event.id;
}

export function runAndRecordCommand(
  capture: CaptureEngine,
  sessionId: string,
  command: string,
  options: RunCommandOptions = {},
): CommandResult {
  const result = runCommand(command, options);
  recordCommandExecution(capture, sessionId, command, result);
  return result;
}
