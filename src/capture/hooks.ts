import type Database from "better-sqlite3";
import type { Event } from "../types.js";

interface HookPayload {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  command?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
}

export function normalizeHookEvent(
  agent: string,
  phase: "pre" | "post",
  payload: HookPayload,
): {
  eventType: Event["eventType"];
  summary: string;
  status: Event["status"];
  rawPayload: HookPayload;
} {
  const toolName = payload.tool_name ?? "unknown";
  const toolInput = payload.tool_input ?? {};
  const command = (toolInput as Record<string, unknown>).command as string ?? payload.command ?? "";

  if (phase === "pre") {
    return {
      eventType: "tool_call",
      summary: `[${agent}] ${toolName}: ${command || JSON.stringify(toolInput).slice(0, 200)}`,
      status: "started",
      rawPayload: payload,
    };
  }

  const hasError = payload.stderr || (payload.exit_code && payload.exit_code !== 0);
  return {
    eventType: "tool_call",
    summary: `[${agent}] ${toolName} completed: exit=${payload.exit_code ?? "unknown"}`,
    status: hasError ? "failed" : "succeeded",
    rawPayload: payload,
  };
}

export function extractCommandFromHook(payload: HookPayload): string | null {
  const toolInput = payload.tool_input ?? {};
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command === "string") return command;
  if (typeof payload.command === "string") return payload.command;
  return null;
}
