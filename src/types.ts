export type MemoryType = "fact" | "bugfix" | "procedure" | "convention" | "warning";

export type EventSource = "hook" | "mcp" | "cli" | "git" | "watcher" | "manual";

export type ActorType = "human" | "agent" | "tool" | "system";

export type EventType =
  | "prompt"
  | "tool_call"
  | "command"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "git_operation"
  | "test_run"
  | "build_run"
  | "approval"
  | "error"
  | "verification"
  | "summary";

export type EventStatus = "started" | "succeeded" | "failed" | "blocked" | "unknown";

export type SessionStatus = "running" | "completed" | "failed" | "interrupted";

export type FailureCategory =
  | "test"
  | "build"
  | "typecheck"
  | "runtime"
  | "dependency"
  | "auth"
  | "database"
  | "deployment"
  | "unknown";

export type FileOperation = "read" | "write" | "patch" | "delete" | "rename";

export type FeedbackOutcome = "success" | "failure" | "ignored";

export interface Session {
  id: string;
  agent: string;
  workspaceRoot: string;
  branch?: string;
  startCommit?: string;
  endCommit?: string;
  startedAt: string;
  endedAt?: string;
  status: SessionStatus;
  summary?: string;
}

export interface Event {
  id: string;
  sessionId: string;
  timestamp: string;
  source: EventSource;
  actorType: ActorType;
  actorName?: string;
  eventType: EventType;
  status: EventStatus;
  summary: string;
  correlationId?: string;
  confidence: number;
}

export interface RawEventPayload {
  eventId: string;
  rawJson?: string;
  rawText?: string;
  redacted: boolean;
  schemaVersion: number;
}

export interface CommandEvent {
  eventId: string;
  command: string;
  shell?: string;
  cwd?: string;
  exitCode?: number;
  stdoutExcerpt?: string;
  stderrExcerpt?: string;
  durationMs?: number;
  semanticId?: string;
}

export interface FileTouch {
  eventId: string;
  path: string;
  operation: FileOperation;
  beforeHash?: string;
  afterHash?: string;
  linesAdded?: number;
  linesRemoved?: number;
  diffExcerpt?: string;
  astAnchors?: ASTAnchor[];
}

export interface ASTAnchor {
  kind: string;
  name: string;
  parent?: string;
  startLine: number;
  endLine: number;
  language: string;
}

export interface Failure {
  id: string;
  sessionId: string;
  eventId?: string;
  fingerprint: string;
  category: FailureCategory;
  message: string;
  failingFile?: string;
  failingTest?: string;
  command?: string;
  firstSeenAt: string;
}

export interface EventLink {
  fromEventId: string;
  toEventId: string;
  relation: "caused" | "followed_by" | "modified" | "read_before" | "failed_in" | "fixed_by" | "verified_by";
}

export interface Memory {
  id: string;
  claim: string;
  type: MemoryType;
  repoScope: string;
  language?: string;
  astAnchors?: ASTAnchor[];
  sources: string[];
  successCount: number;
  failureCount: number;
  confidence: number;
  lastVerified?: string;
  createdAt: string;
  updatedAt: string;
  consolidatedFrom?: string[];
  isActive: boolean;
}

export interface MemoryWithScore extends Memory {
  score: number;
  keywordScore: number;
  semanticScore: number;
  matchedBecause: string;
}

export interface MemoryFeedback {
  id: number;
  memoryId: string;
  usedAt: string;
  context?: string;
  outcome: FeedbackOutcome;
  outcomeDetail?: string;
  sessionId?: string;
}

export interface Procedure {
  id: string;
  name: string;
  description: string;
  repoScope: string;
  stepCount: number;
  steps: string[];
  successCount: number;
  failureCount: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  memories: MemoryWithScore[];
  queryTime: number;
  totalCount: number;
}

export interface CaptureEvent {
  sessionId: string;
  source: EventSource;
  actorType: ActorType;
  actorName?: string;
  eventType: EventType;
  summary: string;
  rawPayload?: unknown;
}

export interface ExtractedMemory {
  claim: string;
  type: MemoryType;
  language?: string;
  astAnchors?: ASTAnchor[];
  sources: string[];
}

export interface RankingWeights {
  keyword: number;
  semantic: number;
  confidence: number;
  freshness: number;
  reliability: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  keyword: 0.25,
  semantic: 0.35,
  confidence: 0.2,
  freshness: 0.1,
  reliability: 0.1,
};
