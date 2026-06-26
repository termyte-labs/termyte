/**
 * OpenCode plugin payload adapter.
 *
 * The OpenCode plugin emits an event payload on the request from one of
 * the bound hooks (`tool.execute.after`, `chat.message`,
 * `experimental.session.compacting`, plus the `event` bus). Field names
 * follow OpenCode's hook API: `sessionID`, `tool`, `args`, `output`,
 * `directory`, plus `event` and `message` for the bus.
 *
 * See claude-mem `src/integrations/opencode-plugin/index.ts:185-298`.
 */
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";
import { passthroughFormatOutput } from "./adapter.js";

export class OpenCodeAdapter implements PlatformAdapter {
  readonly name = "opencode" as const;

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const session_id = pickString(r, ["sessionID", "session_id"]);
    if (!session_id) return null;

    const timestamp = typeof r["timestamp"] === "number"
      ? (r["timestamp"] as number)
      : Date.now();

    const cwd = pickString(r, ["directory", "cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const tool_name = pickString(r, ["tool", "tool_name"]);
    const tool_input = r["args"] ?? r["tool_input"] ?? null;
    const tool_output = r["output"] ?? r["tool_output"] ?? null;

    let event_type: EventType;
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (r["event"] === "session.idle" || r["action"] === "summarize") {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message", "final_response"]);
    } else if (r["event"] === "session.created" || r["action"] === "init") {
      event_type = "session_init";
    } else if (r["event"] === "session.deleted" || r["action"] === "end") {
      event_type = "session_end";
    } else if (r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (isObject(r["message"]) && (r["message"] as any)["role"] === "assistant") {
      event_type = "assistant_message";
      const m = r["message"] as any;
      if (typeof m["content"] === "string") final_response = m["content"];
      else if (Array.isArray(m["parts"])) {
        final_response = m["parts"]
          .map((p: any) => (p && typeof p.text === "string" ? p.text : ""))
          .join("\n");
      }
    } else if (r["message"] && (r["message"] as any)["role"] === "user") {
      event_type = "user_prompt";
      const m = r["message"] as any;
      if (typeof m["content"] === "string") user_prompt = m["content"];
    } else if (tool_name) {
      event_type = "tool_use";
    } else {
      return null;
    }

    return {
      session_id,
      timestamp,
      event_type,
      tool_name,
      tool_input,
      tool_output,
      files_read: null,
      files_modified: null,
      user_prompt,
      final_response,
      cwd,
    };
  }

  formatOutput(result: HookResult): unknown {
    return passthroughFormatOutput(result);
  }
}
