/**
 * Gemini CLI hook payload adapter.
 *
 * Maps Gemini's `SessionStart` / `BeforeAgent` / `AfterAgent` /
 * `BeforeTool` / `AfterTool` / `PreCompress` / `Notification` events to
 * the shared NormalizedEvent shape. Falls back to env vars for cwd and
 * session_id when the agent does not pass them on stdin (Gemini hooks
 * are still partly in flux).
 *
 * See claude-mem `src/cli/adapters/gemini-cli.ts:1-79`.
 */
import type { PlatformAdapter, NormalizedEvent, HookResult } from "./adapter.js";
import { isObject, pickString } from "./util.js";
import { AdapterRejectedInput, isValidCwd } from "./errors.js";

export class GeminiCliAdapter implements PlatformAdapter {
  readonly name = "gemini-cli" as PlatformAdapter["name"];

  normalize(raw: unknown): NormalizedEvent | null {
    if (!isObject(raw)) return null;
    const r = raw;

    const cwd = pickString(r, ["cwd"])
      ?? process.env.GEMINI_CWD
      ?? process.env.GEMINI_PROJECT_DIR
      ?? process.env.CLAUDE_PROJECT_DIR
      ?? process.cwd();
    if (!isValidCwd(cwd)) {
      throw new AdapterRejectedInput("invalid_cwd");
    }

    const session_id = pickString(r, ["session_id"])
      ?? process.env.GEMINI_SESSION_ID
      ?? "gemini-unknown";
    const timestamp = typeof r["timestamp"] === "number" ? r["timestamp"] : Date.now();

    const hookEventName = pickString(r, ["hook_event_name"]);

    let tool_name: string | null = pickString(r, ["tool_name"]);
    let tool_input: unknown = r["tool_input"] ?? null;
    let tool_output: unknown = r["tool_response"] ?? null;

    if (hookEventName === "AfterAgent" && r["prompt_response"]) {
      tool_name = tool_name ?? "GeminiProvider";
      tool_input = tool_input ?? { prompt: r["prompt"] };
      tool_output = tool_output ?? { response: r["prompt_response"] };
    }
    if (hookEventName === "BeforeTool" && tool_name && !tool_output) {
      tool_output = { _preExecution: true };
    }
    if (hookEventName === "Notification") {
      tool_name = tool_name ?? "GeminiNotification";
      tool_input = tool_input ?? {
        notification_type: r["notification_type"],
        message: r["message"],
      };
      tool_output = tool_output ?? { details: r["details"] };
    }

    let event_type: NormalizedEvent["event_type"];
    let user_prompt: string | null = null;
    let final_response: string | null = null;

    if (hookEventName === "AfterAgent" && r["prompt_response"]) {
      // AfterAgent with prompt_response is a tool_use-shaped observation
      // of the model itself — same shape claude-mem uses.
      event_type = "tool_use";
    } else if (r["prompt"] !== undefined) {
      event_type = "user_prompt";
      user_prompt = pickString(r, ["prompt"]);
    } else if (r["last_assistant_message"] !== undefined) {
      event_type = "assistant_message";
      final_response = pickString(r, ["last_assistant_message"]);
    } else if (hookEventName === "SessionStart" || hookEventName === "BeforeAgent") {
      event_type = "session_init";
    } else if (hookEventName === "PreCompress") {
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
    const out: Record<string, unknown> = {};
    out.continue = result.continue ?? true;
    if (result.suppressOutput !== undefined) out.suppressOutput = result.suppressOutput;
    if (result.systemMessage) {
      const ansiRegex = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
      out.systemMessage = result.systemMessage.replace(ansiRegex, "");
    }
    if (result.hookSpecificOutput) {
      out.hookSpecificOutput = {
        additionalContext: result.hookSpecificOutput.additionalContext,
      };
    }
    return out;
  }
}
