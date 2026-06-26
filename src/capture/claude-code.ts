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
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import type { EventType } from "../core/types.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";

const MAX_AGENT_FIELD_LEN = 128;
const pickAgentField = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_AGENT_FIELD_LEN ? v : undefined;

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

    const cwd = pickString(r, ["cwd"]) ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

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
    if (result.hookSpecificOutput) {
      const out: Record<string, unknown> = { hookSpecificOutput: result.hookSpecificOutput };
      if (result.systemMessage) out.systemMessage = result.systemMessage;
      return out;
    }
    const out: Record<string, unknown> = {};
    if (result.systemMessage) out.systemMessage = result.systemMessage;
    return out;
  }
}
