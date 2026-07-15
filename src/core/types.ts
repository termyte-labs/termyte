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
  | "helpful"
  | "harmful"
  | "ignored"
  | "downranked"
  | "corrected";

export interface CodeApplicabilityEvidence {
  files: string[];
  commands: string[];
  trace_ids: number[];
  observation_ids: number[];
}

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
  redaction?: {
    applied: boolean;
    findings: string[];
  } | null;
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
  applicability_evidence?: CodeApplicabilityEvidence | null;
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

export type EpisodeStatus = "active" | "succeeded" | "failed" | "partial" | "abandoned" | "unknown";
export type EvidenceKind = "command" | "test" | "build" | "diff" | "file" | "human_feedback" | "agent_statement";
export type OutcomeStatus = Exclude<EpisodeStatus, "active">;

export interface Episode {
  id: string;
  session_id: string;
  repo_id: string;
  workspace_root: string;
  task: string;
  status: EpisodeStatus;
  base_commit: string | null;
  final_commit: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface Evidence {
  id: string;
  episode_id: string;
  kind: EvidenceKind;
  content: string;
  exit_code: number | null;
  metadata: Record<string, unknown>;
  observed_at: number;
}

export interface EpisodeOutcome {
  id: string;
  episode_id: string;
  status: OutcomeStatus;
  source: "inferred" | "human" | "viewer";
  notes: string | null;
  context_injection_id: string | null;
  created_at: number;
}

export type ContextCandidateKind =
  | "current_state"
  | "repository_knowledge"
  | "episode"
  | "summary"
  | "observation"
  | "memory"
  | "procedure"
  | "evidence";

export type ContextRejectionReason =
  | "below_threshold"
  | "redundant"
  | "token_budget"
  | "ineligible_lifecycle"
  | "wrong_repository"
  | "broken_provenance"
  | "missing_file";

export interface CompiledContextCandidate {
  candidate_id: string;
  kind: ContextCandidateKind;
  source_id: string | null;
  rendered_text: string;
  token_estimate: number;
  final_score: number;
  score_breakdown: Record<string, number>;
  lifecycle_state: string | null;
  applicability_state: "applicable" | "stale_exact_match" | "ineligible";
  selected: boolean;
  rank: number | null;
  rejection_reason: ContextRejectionReason | null;
}

export interface ContextPacket {
  id: string;
  session_id: string | null;
  episode_id: string | null;
  repo_id: string;
  agent: string;
  task: string;
  token_budget: number;
  estimated_tokens: number;
  retrieval_mode: string;
  latency_ms: number;
  rendered_text: string;
  created_at: number;
}

export interface ContextCandidate {
  packet_id: string;
  candidate_id: string;
  kind: ContextCandidateKind;
  source_id: string | null;
  token_estimate: number;
  selected: boolean;
  rank: number | null;
  final_score: number;
  score_breakdown: Record<string, unknown>;
  rejection_reason: string | null;
  rendered_text: string;
}
