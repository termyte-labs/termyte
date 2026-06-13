export type Decision = "allow" | "warn" | "ask" | "block";

export type ActionKind =
  | "filesystem.delete"
  | "filesystem.write"
  | "git.push"
  | "git.destructive"
  | "package.install"
  | "package.publish"
  | "secret.access"
  | "remote-script.execution"
  | "privilege.escalation"
  | "docker.destructive"
  | "deploy.mutation"
  | "sql.destructive"
  | "shell.generic";

export type ShellFlavor = "cmd" | "powershell" | "sh";

export interface ParsedAction {
  rawCommand: string;
  redactedCommand: string;
  tokens: string[];
  shell: ShellFlavor;
  kind: ActionKind;
  semanticId: string;
  domain: string;
  operation: string;
  target: string;
  flags: string[];
  isWildcard: boolean;
  isRecursive: boolean;
  isForce: boolean;
  sqlPattern?: "drop-table" | "truncate-table" | "delete-without-where" | "delete-with-where";
  gitBranch?: string;
  packageManager?: "npm" | "pnpm" | "yarn";
  confidence: number;
}

export interface ResolvedTargets {
  targetKind: "filesystem" | "git" | "package" | "sql" | "unknown";
  workspaceRoot: string;
  insideWorkspace: boolean;
  targetCount: number;
  expandedTargets: string[];
  protectedTargets: string[];
  protectedBranch?: boolean;
  sensitiveTargets: string[];
  targetClasses: TargetClassification[];
  recoverability: "high" | "medium" | "low";
  outsideWorkspace: boolean;
}

export interface TargetClassification {
  target: string;
  category:
    | "git-metadata"
    | "workspace-source"
    | "workspace-root"
    | "config"
    | "environment"
    | "build-output"
    | "dependency-tree"
    | "home"
    | "filesystem-root"
    | "normal";
  sensitive: boolean;
  reason: string;
}

export interface RiskResult {
  decision: Decision;
  score: number;
  level?: "low" | "medium" | "high" | "critical";
  ruleId?: string;
  reason: string;
  signals: string[];
  suggestedFix?: string;
}

export interface MemoryMatch {
  memoryId: number;
  semanticId: string;
  workspaceRoot: string;
  totalCount: number;
  lastOutcome: string;
  confidence: number;
  score: number;
  falsePositiveCount: number;
  matchedBecause: string;
  lesson: string;
}

export interface InspectionReport {
  action: ParsedAction;
  targets: ResolvedTargets;
  risk: RiskResult;
  policy: {
    decision: Decision;
    reason: string;
    matchedRule?: string;
    matchedPolicy?: string;
    matchedPolicies?: string[];
  };
  memoryMatches: MemoryMatch[];
  finalDecision: Decision;
  finalReason: string;
  safeAlternative?: string;
  matchedPolicies?: string[];
}

export interface ReplayEntry {
  timestamp: string;
  action: string;
  runtime?: string;
  launchedVia?: string;
  agentName?: string;
  runtimeProfile?: string;
  commandCorrelationId?: string;
  semanticMeaning: string;
  blastRadius: {
    score: number | null;
    reason: string | null;
    targets: string;
  };
  memoryMatches: MemoryMatch[];
  finalDecision: Decision | "pending";
  outcome: string;
}

export interface ExecutionOutcome {
  status: "executed" | "blocked" | "failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  errorMessage?: string;
}

export interface RuntimeRecord {
  id: number;
  createdAt: string;
  workspaceRoot: string;
  rawCommand: string;
  redactedCommand: string;
  semanticId: string;
  kind: ActionKind;
  operation: string;
  decision: Decision | "pending";
  riskScore: number | null;
  riskReason: string | null;
  targetSummary: string;
  targetCount: number;
  executed: 0 | 1;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  status: "planned" | "executed" | "blocked" | "failed";
  envKeysJson: string;
  metadataJson: string;
}

export interface MemoryEntry {
  memoryId: number;
  semanticId: string;
  workspaceRoot: string;
  kind: ActionKind;
  operation: string;
  sampleCommand: string;
  lastOutcome: string;
  totalCount: number;
  allowCount: number;
  warnCount: number;
  blockCount: number;
  failCount: number;
  falsePositiveCount: number;
  confidence: number;
  updatedAt: string;
}

export interface LocalMemoryRecord {
  memory_id: string;
  created_at: string;
  type: "safe" | "unsafe";
  pattern: string;
  normalized_pattern: string;
  reason_optional?: string;
  repo_scope: "repo";
  source: "user";
}

export interface LocalMemoryMatch {
  memory_id: string;
  type: "safe" | "unsafe";
  pattern: string;
  source: "user";
}

export interface LocalLogEvent {
  event_id: string;
  timestamp: string;
  repo: string;
  agent?: string;
  session_id?: string;
  command: string;
  normalized_command: string;
  decision: Decision;
  action: Decision;
  risk: "low" | "medium" | "high" | "critical";
  reason: string;
  matched_rules: Array<{
    name: string;
    action: Decision;
    source: string;
    preset?: string;
  }>;
  policy_sources: string[];
  memory_matches: LocalMemoryMatch[];
}
