import fs from "node:fs";
import { setTimeout as setTimeoutPromise } from "node:timers/promises";
import type { NormalizedHookInput, HookResult, PlatformAdapter } from "../types.js";
import type { Logger } from "./logger.js";

export const HOOK_TIMEOUTS = Object.freeze({
  startup: 30000,
  session: 60000,
  observation: 120000,
  response: 120000,
  max: 600000,
});

export const HOOK_EXIT = Object.freeze({
  timeout: 1,
  error: 2,
  noMemoryHook: 3,
  invalidInput: 4,
});

export async function readStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) {
    return undefined;
  }
  return JSON.parse(text);
}

export async function runWithTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs: number,
  logger: Logger,
): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const result = await Promise.race([fn(), setTimeoutPromise(timeoutMs, undefined, { ref: false }).then(() => { throw new Error(`${label} timed out after ${timeoutMs}ms`); })]);
    return { ok: true, result };
  } catch (error) {
    logger.error(`[hook:${label}] failed`, error as Error);
    return { ok: false, error };
  }
}

export function writeJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data));
}

export function exitWithCode(code: number, message: string, logger: Logger): never {
  logger.error(message);
  process.exit(code);
}

export function buildHookResult(hookSpecificOutput: HookResult["hookSpecificOutput"]): HookResult {
  return {
    continue: true,
    suppressOutput: true,
    hookSpecificOutput: hookSpecificOutput ?? {
      hookEventName: "termyte",
      additionalContext: "",
    },
  };
}

export async function dispatchHook(
  event: string,
  normalizedInput: NormalizedHookInput,
  handlers: Record<string, () => Promise<HookResult>>,
  logger: Logger,
): Promise<HookResult> {
  const handler = handlers[event];
  if (!handler) {
    return buildHookResult({
      hookEventName: event,
      additionalContext: "",
    });
  }

  const result = await runWithTimeout(event, handler, HOOK_TIMEOUTS.session, logger);
  if (!result.ok) {
    return buildHookResult({
      hookEventName: event,
      additionalContext: "",
    });
  }

  return result.result;
}
