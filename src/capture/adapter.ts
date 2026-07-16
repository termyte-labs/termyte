/**
 * PlatformAdapter — the single contract every agent-specific parser
 * implements. `normalize` converts the agent's raw hook payload into the
 * shared `NormalizedEvent`; `formatOutput` converts an outgoing `HookResult`
 * into the agent's response envelope (Claude Code reads stdout JSON, Cursor
 * reads its own shape, etc.).
 *
 * The interface is intentionally minimal so the runner and downstream
 * pipeline can stay platform-agnostic.
 */

import type { EventType, Platform } from "../core/types.js";

/** Common trace shape, written to the `traces` table. */
export interface NormalizedEvent {
  session_id: string;
  timestamp: number;
  event_type: EventType;
  tool_name: string | null;
  tool_input: unknown | null;
  tool_output: unknown | null;
  files_read: string[] | null;
  files_modified: string[] | null;
  user_prompt: string | null;
  final_response: string | null;
  /** Working directory at the time of the event. Not persisted in the trace. */
  cwd: string;
}

/** Hook output envelope — what an adapter returns to the agent. */
export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  systemMessage?: string;
  /** Per-event extras the agent protocol understands. */
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    contextInjectionId?: string;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
  decision?: "block" | "approve";
  reason?: string;
}

export interface PlatformAdapter {
  readonly name: Platform;
  /** Convert a raw hook payload to the common trace format. */
  normalize(raw: unknown): NormalizedEvent | null;
  /** Convert a HookResult into the agent's response envelope. */
  formatOutput(result: HookResult): unknown;
}

/**
 * Default output envelope for agents that just need `{continue:true}`.
 * Used by raw and adapters that do not need a platform-specific envelope.
 */
export function passthroughFormatOutput(result: HookResult): unknown {
  return {
    continue: result.continue ?? true,
    ...(result.hookSpecificOutput ? { hookSpecificOutput: result.hookSpecificOutput } : {}),
  };
}
