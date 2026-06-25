/**
 * Core types for the Termyte memory layer.
 *
 * The architecture is:
 *   Agent Events (raw, per-platform)
 *     -> Traces (common format, stored raw in `traces` table)
 *     -> Observer (LLM-based extraction)
 *     -> Memories (structured, stored in `memories` table)
 *     -> Retrieval (FTS + vector + hybrid)
 *
 * This file declares the in-memory and storage types. The SQL schema lives
 * in `src/storage/migrations.ts`.
 */

export type EventType =
  | "session_init"
  | "user_prompt"
  | "tool_use"
  | "assistant_message"
  | "session_end";

export type Platform = "claude-code" | "codex" | "opencode" | "cursor";

export type MemoryType =
  | "bugfix"
  | "feature"
  | "refactor"
  | "change"
  | "discovery"
  | "decision";

/** Common trace shape, written to the `traces` table. */
export interface Trace {
  id: number;
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
  /** Internal: when the observer consumed this trace. null = unprocessed. */
  processed_at: number | null;
}

/** Session row. */
export interface Session {
  id: number;
  session_id: string;
  project: string;
  started_at: number;
  ended_at: number | null;
}

/** Memory row, written to the `memories` table. */
export interface Memory {
  id: number;
  session_id: string;
  type: MemoryType;
  title: string;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
  created_at: number;
  /** Float32 vector, optional. Stored as a BLOB and decoded lazily. */
  embedding: Float32Array | null;
}

/** Summary row, one per session. */
export interface Summary {
  id: number;
  session_id: string;
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  created_at: number;
}
