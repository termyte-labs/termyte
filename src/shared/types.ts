export type Platform = "claude-code" | "codex";

export type EventType =
  | "session_init"
  | "user_prompt"
  | "tool_use"
  | "assistant_message"
  | "session_end";

export interface Session {
  id: number;
  session_id: string;
  project: string;
  repo_id: string | null;
  workspace_root: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface Trace {
  id: number;
  session_id: string;
  platform_event_id: string | null;
  timestamp: number;
  event_type: EventType;
  tool_name: string | null;
  tool_input: unknown;
  tool_output: unknown;
  files_read: string[] | null;
  files_modified: string[] | null;
  user_prompt: string | null;
  final_response: string | null;
  redaction: unknown;
}

export interface SessionHandoff {
  id: number;
  source_session_id: string;
  target_session_id: string;
  repo_id: string;
  content: string;
  created_at: number;
}
