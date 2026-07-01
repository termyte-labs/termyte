/**
 * Core types for the Termyte memory layer.
 *
 * Architecture: Trace → Observation → Memory
 *
 *   Agent Events (raw, per-platform)
 *     → Traces (immutable, stored raw in `traces` table)
 *     → Observer stage 1 (LLM: traces → observations)
 *     → Observer stage 2 (LLM: observations → memories)
 *     → Retrieval (FTS + vector + hybrid)
 *
 * Raw traces are never discarded. Observations are derived from traces.
 * Memories are derived from observations. Full provenance chain.
 */

export type EventType =
  | "session_init"
  | "user_prompt"
  | "tool_use"
  | "assistant_message"
  | "session_end";

export type Platform = "claude-code" | "codex" | "opencode" | "cursor" | "gemini-cli" | "windsurf" | "raw";

/** Memory types per MVP spec. */
export type MemoryType =
  | "bugfix"
  | "convention"
  | "warning"
  | "procedure"
  | "fact";

/** Observation types (same as memory types). */
export type ObservationType = MemoryType;

export type MemoryState =
  | "active"
  | "stale"
  | "superseded"
  | "conflicted"
  | "deleted";

export type MemoryEdgeType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "duplicates"
  | "derived_from"
  | "related_to";

export type MemoryFeedbackEvent =
  | "shown"
  | "used"
  | "ignored"
  | "downranked"
  | "corrected";

export type TracePipelineState =
  | "captured"
  | "observation_pending"
  | "observation_ready"
  | "memory_pending"
  | "memory_ready"
  | "failed";

export type ObservationLifecycleState =
  | "extracting"
  | "awaiting_embedding"
  | "indexed"
  | "failed"
  | "superseded"
  | "deleted";

export type MemoryLifecycleState =
  | "consolidating"
  | "awaiting_embedding"
  | "active"
  | "stale"
  | "superseded"
  | "conflicted"
  | "deleted"
  | "failed";

/** Common trace shape, written to the `traces` table. Immutable. */
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
  pipeline_state?: TracePipelineState;
}

/** Session row. */
export interface Session {
  id: number;
  session_id: string;
  project: string;
  repo_id: string | null;
  workspace_root: string | null;
  started_at: number;
  ended_at: number | null;
}

/**
 * Observation row, written to the `observations` table.
 * Extracted from one or more traces by the observer.
 */
export interface Observation {
  id: number;
  session_id: string;
  repo_id: string;
  workspace_root: string;
  type: ObservationType;
  title: string;
  description: string | null;
  files_read: string[];
  files_modified: string[];
  commands_executed: string[];
  source_trace_ids: number[];
  created_at: number;
  processed_at: number | null;
  lifecycle_state?: ObservationLifecycleState;
}

/**
 * Memory row, written to the `memories` table.
 * Consolidated from observations across sessions.
 */
export interface Memory {
  id: number;
  session_id: string;
  repo_id: string;
  workspace_root: string;
  type: MemoryType;
  title: string;
  description: string | null;
  files_read: string[];
  files_modified: string[];
  /** Observation IDs that contributed to this memory. */
  source_observation_ids: number[];
  /** Trace IDs that contributed (transitive provenance). */
  source_trace_ids: number[];
  created_at: number;
  embedding: Float32Array | null;
  lifecycle_state?: MemoryLifecycleState;
  state?: MemoryState;
  importance?: number;
  confidence?: number;
  usage_count?: number;
  last_accessed_at?: number | null;
  last_reinforced_at?: number | null;
  decayed_score?: number;
  content_hash?: string | null;
  canonical_key?: string | null;
  superseded_by?: number | null;
}

/** Summary row, one per session. */
export interface Summary {
  id: number;
  session_id: string;
  repo_id: string;
  workspace_root: string;
  summary: string | null;
  key_changes: string[] | null;
  key_learnings: string[] | null;
  created_at: number;
}
