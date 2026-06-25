import type { PlatformAdapter, NormalizedEvent } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { extractFilesFromEvent } from "./files.js";
import { isObject, pickString } from "./util.js";

/**
 * Codex CLI hook payload adapter.
 *
 * Codex native hooks emit a JSON object with the same shape as Claude
 * Code's, plus an optional `hook_event_name` field that names the event
 * (SessionStart, UserPromptSubmit, PostToolUse, etc.).
 *
 * See claude-mem `src/cli/adapters/codex.ts:59-103`.
 */
export class CodexAdapter implements PlatformAdapter {
  readonly name = "codex" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["session_id", "sessionId"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();
    const cwd = pickString(r, ["cwd"]) ?? null;

    const tool_name = pickString(r, ["tool_name", "toolName"]);
    const tool_input = (r["tool_input"] ?? r["toolInput"]) ?? null;
    const tool_output = r["tool_response"] ?? r["tool_output"] ?? r["toolOutput"] ?? null;

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (r["hook_event_name"] === "SessionStart") {
      event_type = "session_init";
    } else if (r["hook_event_name"] === "SessionEnd") {
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
