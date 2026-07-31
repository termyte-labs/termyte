import type { EventType } from "../../shared/types.js";
import type { HookResult, NormalizedEvent, PlatformAdapter } from "../../capture/adapter.js";
import { AdapterRejectedInput, isValidCwd } from "../../capture/errors.js";
import { isObject, pickString } from "../../capture/util.js";

/** Normalizes payloads emitted by Termyte's OpenCode plugin. */
export class OpenCodeAdapter implements PlatformAdapter {
  readonly name = "opencode" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const session_id = pickString(raw, ["session_id", "sessionID"]);
    if (!session_id) return null;
    const cwd = pickString(raw, ["cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) throw new AdapterRejectedInput("invalid_cwd");
    const kind = pickString(raw, ["event", "hook_event_name"]);
    let event_type: EventType;
    if (kind === "session_start") event_type = "session_init";
    else if (kind === "user_prompt") event_type = "user_prompt";
    else if (kind === "assistant_message") event_type = "assistant_message";
    else if (kind === "tool_completed") event_type = "tool_use";
    else if (kind === "compaction") event_type = "compaction";
    else if (kind === "session_idle") event_type = "session_end";
    else return null;

    return {
      session_id,
      platform_event_id: pickString(raw, ["event_id", "callID", "message_id"]) ?? null,
      timestamp: typeof raw["timestamp"] === "number" ? raw["timestamp"] : Date.now(),
      event_type,
      tool_name: pickString(raw, ["tool_name", "tool"]) ?? null,
      tool_input: raw["tool_input"] ?? raw["args"] ?? null,
      tool_output: raw["tool_output"] ?? raw["output"] ?? null,
      files_read: null,
      files_modified: null,
      user_prompt: event_type === "user_prompt" ? pickString(raw, ["prompt", "text"]) ?? null : null,
      final_response: event_type === "assistant_message" ? pickString(raw, ["message", "text"]) ?? null : null,
      cwd,
    };
  }

  formatOutput(_result: HookResult): unknown { return {}; }
}
