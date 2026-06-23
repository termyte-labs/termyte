export type MemoryType = "fact" | "bugfix" | "procedure" | "convention" | "warning";

export type PlatformSource = "termyte" | "claude-code" | "codex" | "cursor" | "windsurf" | "gemini-cli";

export type ActorType = "human" | "agent" | "tool" | "system";

export type ObservationType =
  | "bugfix"
  | "discovery"
  | "decision"
  | "refactor"
  | "optimization"
  | "test"
  | "documentation"
  | "configuration"
  | "dependency"
  | "security"
  | "performance"
  | "architecture"
  | "investigation";

export type EventStatus = "started" | "succeeded" | "failed" | "blocked" | "unknown";

export type SessionStatus = "active" | "completed" | "failed";

export type PendingMessageType = "observation" | "summarize";

export type PendingMessageStatus = "pending" | "processing";

export type FeedbackOutcome = "success" | "failure" | "ignored";

export type FileOperation = "read" | "write" | "patch" | "delete" | "rename";

// --- Hook System Types ---

export interface NormalizedHookInput {
  sessionId: string;
  cwd: string;
  platform?: string;
  prompt?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  transcriptPath?: string;
  lastAssistantMessage?: string;
  turnId?: string;
  stopHookActive?: boolean;
  permissionMode?: string;
  model?: string;
  sessionSource?: "startup" | "resume" | "clear";
  filePath?: string;
  edits?: unknown[];
  agentId?: string;
  agentType?: string;
}

export interface HookResult {
  continue?: boolean;
  suppressOutput?: boolean;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    permissionDecision?: "allow" | "deny";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
  systemMessage?: string;
  decision?: "block" | "approve";
  reason?: string;
  exitCode?: number;
}

export interface PlatformAdapter {
  normalizeInput(raw: unknown): NormalizedHookInput;
  formatOutput(result: HookResult): unknown;
}

export interface EventHandler {
  execute(input: NormalizedHookInput): Promise<HookResult>;
}

// --- Storage Types ---

export interface Session {
  id: number;
  contentSessionId: string;
  memorySessionId?: string;
  project: string;
  platformSource: PlatformSource;
  userPrompt?: string;
  startedAt: string;
  startedAtEpoch: number;
  completedAt?: string;
  completedAtEpoch?: number;
  status: SessionStatus;
  promptCounter: number;
  customTitle?: string;
}

export interface Observation {
  id: number;
  memorySessionId: string;
  project: string;
  text?: string;
  type: string;
  title?: string;
  subtitle?: string;
  facts?: string;
  narrative?: string;
  concepts?: string;
  filesRead?: string;
  filesModified?: string;
  promptNumber?: number;
  discoveryTokens: number;
  contentHash?: string;
  agentType?: string;
  agentId?: string;
  generatedByModel?: string;
  relevanceCount: number;
  metadata?: string;
  createdAt: string;
  createdAtEpoch: number;
}

export interface PendingMessage {
  id: number;
  sessionDbId: number;
  contentSessionId: string;
  toolUseId?: string;
  messageType: PendingMessageType;
  toolName?: string;
  toolInput?: string;
  toolResponse?: string;
  cwd?: string;
  lastUserMessage?: string;
  lastAssistantMessage?: string;
  promptNumber?: number;
  status: PendingMessageStatus;
  createdAtEpoch: number;
  agentType?: string;
  agentId?: string;
}

export interface UserPrompt {
  id: number;
  contentSessionId: string;
  promptNumber: number;
  promptText: string;
  createdAt: string;
  createdAtEpoch: number;
}

// --- Extraction Types ---

export interface ParsedObservation {
  type: string;
  title: string | null;
  subtitle: string | null;
  facts: string[];
  narrative: string | null;
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ParsedSummary {
  request: string | null;
  investigated: string | null;
  learned: string | null;
  completed: string | null;
  next_steps: string | null;
  notes: string | null;
  skipped?: boolean;
  skip_reason?: string | null;
}

export type ParseResult =
  | { valid: true; observations: ParsedObservation[]; summary: ParsedSummary | null }
  | { valid: false };

export type ObserverOutputClass = "xml" | "idle" | "prose" | "poisoned";

// --- Existing Types (kept) ---

export interface ASTAnchor {
  kind: string;
  name: string;
  parent?: string;
  startLine: number;
  endLine: number;
  language: string;
}

export interface Memory {
  id: string;
  claim: string;
  type: MemoryType;
  repoScope: string;
  language?: string;
  astAnchors?: ASTAnchor[];
  sources: string[];
  filesRead?: string;
  filesModified?: string;
  concepts?: string;
  embedding?: Buffer;
  successCount: number;
  failureCount: number;
  confidence: number;
  lastVerified?: string;
  lastOutcomeAt?: string;
  lastOutcomeType?: string;
  createdAt: string;
  updatedAt: string;
  consolidatedFrom?: unknown;
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

export interface RankingWeights {
  keyword: number;
  semantic: number;
  confidence: number;
  freshness: number;
  reliability: number;
}

export const DEFAULT_RANKING_WEIGHTS: RankingWeights = {
  keyword: 0.25,
  semantic: 0.30,
  confidence: 0.25,
  freshness: 0.10,
  reliability: 0.10,
};

export interface ExtractedMemory {
  claim: string;
  type: MemoryType;
  language?: string;
  astAnchors?: ASTAnchor[];
  sources: string[];
}
