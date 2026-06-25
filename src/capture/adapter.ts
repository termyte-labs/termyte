import type { EventType, Platform } from "../core/types.js";

/**
 * The common trace format.
 *
 * Every agent's raw hook payload is normalized to this shape by an
 * adapter. Nothing else in Termyte touches raw event payloads.
 */
export interface NormalizedEvent {
  /** External session id (whatever the agent calls it). */
  session_id: string;
  /** Event time in milliseconds since epoch. */
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
  cwd: string | null;
}

export interface PlatformAdapter {
  readonly name: Platform;
  /** Convert a raw hook payload to the common trace format. */
  normalize(raw: unknown): NormalizedEvent | null;
}
