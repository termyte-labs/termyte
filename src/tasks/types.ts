export type TaskStatus = "active" | "completed" | "paused" | "cancelled";
export type StepStatus = "pending" | "active" | "verified" | "failed" | "blocked";
export type EvidenceKind = "command" | "test" | "git" | "file" | "user";
export type EvidenceVerdict = "passed" | "failed" | "inconclusive";

export interface Task {
  id: string; repo_id: string; title: string; objective: string; status: TaskStatus;
  current_phase: string | null; current_step_id: string | null; version: number;
  created_at: number; updated_at: number;
  workspace_root?: string | null; last_session_id?: string | null;
  last_files?: string[]; last_terms?: string[]; confidence?: number;
}

export type TaskDetectionDecision = "continue" | "new" | "uncertain";
export type WorkThreadObservationKind = "requirement" | "decision" | "discovery" | "attempt" | "failure" | "warning" | "verification";
export type WorkThreadObservationState = "active" | "stale" | "superseded" | "conflicted" | "deleted" | "quarantined";

export interface WorkThreadObservation {
  id: string; task_id: string; kind: WorkThreadObservationKind; claim: string; reason: string | null;
  confidence: number; lifecycle_state: WorkThreadObservationState; files: string[];
  source_event_ids: number[]; created_at: number; updated_at: number;
}

export interface TaskDetection {
  id: string;
  task_id: string | null;
  session_id: string;
  repo_id: string;
  workspace_root: string | null;
  decision: TaskDetectionDecision;
  score: number;
  evidence: string[];
  signals: Record<string, number>;
  prompt: string | null;
  created_at: number;
}

export interface TaskStep {
  id: string; task_id: string; title: string; position: number; status: StepStatus;
  verification_type: string | null; created_at: number; updated_at: number;
}

export interface VerificationEvidence {
  id: string; task_id: string; evidence_kind: EvidenceKind; trace_id: number | null;
  command_id: string | null; payload: Record<string, unknown>; verdict: EvidenceVerdict; created_at: number;
}
