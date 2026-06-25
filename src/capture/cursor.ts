import type { PlatformAdapter, NormalizedEvent } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { extractFilesFromEvent } from "./files.js";
import { isObject, pickString } from "./util.js";

/**
 * Cursor hook payload adapter.
 *
 * Cursor's hook protocol is shaped like Claude Code's but with a few
 * renames: `conversation_id` for the session, `workspace_roots` for
 * `cwd`, `result_json` for the tool response, and `event` for the
 * lifecycle event name.
 *
 * See claude-mem `src/cli/adapters/cursor.ts:30-53`.
 */
export class CursorAdapter implements PlatformAdapter {
  readonly name = "cursor" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["conversation_id", "session_id", "generation_id"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();

    let cwd: string | null = null;
    if (Array.isArray(r["workspace_roots"]) && r["workspace_roots"]!.length > 0) {
      const first = r["workspace_roots"]![0];
      if (typeof first === "string") cwd = first;
    }
    if (!cwd) cwd = pickString(r, ["cwd"]);

    const tool_name = pickString(r, ["tool_name", "toolName"]);
    const tool_input = r["tool_input"] ?? r["toolInput"] ?? r["args"] ?? null;
    const tool_output =
      r["result_json"] ?? r["tool_response"] ?? r["tool_output"] ?? r["result"] ?? null;

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["event"] === "beforeSubmitPrompt" || r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["event"] === "stop" || r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (r["event"] === "sessionStart") {
      event_type = "session_init";
    } else if (r["event"] === "sessionEnd") {
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
