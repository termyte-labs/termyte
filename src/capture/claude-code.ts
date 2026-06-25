import type { PlatformAdapter, NormalizedEvent } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { extractFilesFromEvent } from "./files.js";

/**
 * Claude Code hook payload adapter.
 *
 * Claude Code sends a JSON object on stdin with fields like
 *   { session_id, cwd, tool_name, tool_input, tool_response,
 *     hook_event_name, prompt, last_assistant_message, ... }
 *
 * See claude-mem `src/cli/adapters/claude-code.ts:8-26` for the
 * upstream reference.
 */
export class ClaudeCodeAdapter implements PlatformAdapter {
  readonly name = "claude-code" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["session_id", "sessionId", "id"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();
    const cwd = pickString(r, ["cwd"]) ?? null;

    const tool_name = pickString(r, ["tool_name", "toolName"]);
    const tool_input = (r["tool_input"] ?? r["toolInput"]) ?? null;
    const tool_output =
      r["tool_response"] ?? r["tool_output"] ?? r["toolOutput"] ?? r["result"] ?? null;

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (r["hook_event_name"] === "SessionStart" || r["hook_event_name"] === "sessionStart") {
      event_type = "session_init";
    } else if (r["hook_event_name"] === "SessionEnd" || r["hook_event_name"] === "sessionEnd") {
      event_type = "session_end";
    } else if (tool_name) {
      event_type = "tool_use";
    } else {
      return null;
    }

    let files_read: string[] | null = null;
    let files_modified: string[] | null = null;
    if (tool_name) {
      const f = extractFilesFromEvent(tool_name, tool_input, tool_output);
      files_read = f.read.length > 0 ? f.read : null;
      files_modified = f.modified.length > 0 ? f.modified : null;
    }

    return {
      session_id,
      timestamp,
      event_type,
      tool_name,
      tool_input,
      tool_output,
      files_read,
      files_modified,
      user_prompt,
      final_response,
      cwd,
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // Some agents pass undefined explicitly, treat as null.
  for (const k of keys) {
    if (k in o) return null;
  }
  return null;
}
