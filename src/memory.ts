import type Database from "better-sqlite3";
import type { ExecutionOutcome, MemoryMatch, ParsedAction, RiskResult, ResolvedTargets } from "./types.js";

export interface MemorySnapshot {
  semanticId: string;
  workspaceRoot: string;
  kind: string;
  operation: string;
  sampleCommand: string;
  lastOutcome: string;
  totalCount: number;
  allowCount: number;
  warnCount: number;
  blockCount: number;
  failCount: number;
  confidence: number;
  updatedAt: string;
}

export class MemoryEngine {
  constructor(private readonly db: Database.Database) {}

  findMatches(action: ParsedAction, targets: ResolvedTargets): MemoryMatch[] {
    const rows = this.db
      .prepare(
        `SELECT semantic_id, workspace_root, kind, operation, total_count, last_outcome, confidence
         FROM memory_entries
         WHERE kind = ? AND operation = ?`,
      )
      .all(action.kind, action.operation) as Array<{
      semantic_id: string;
      workspace_root: string;
      kind: string;
      operation: string;
      total_count: number;
      last_outcome: string;
      confidence: number;
    }>;

    const actionLabels = semanticLabels(action.semanticId);

    return rows
      .map((row) => {
        const candidateLabels = semanticLabels(row.semantic_id);
        const overlap = overlapScore(actionLabels, candidateLabels);
        const workspaceBoost = row.workspace_root === targets.workspaceRoot ? 0.2 : 0;
        const exactSemanticBoost = row.semantic_id === action.semanticId ? 0.35 : 0;
        const exactWorkspaceBoost = row.workspace_root === targets.workspaceRoot ? 0.1 : 0;
        const score = Math.min(1, overlap + workspaceBoost + exactSemanticBoost + exactWorkspaceBoost);
        const overlapText = [...actionLabels]
          .filter((label) => candidateLabels.has(label))
          .sort()
          .join(", ");

        return {
          semanticId: row.semantic_id,
          workspaceRoot: row.workspace_root,
          totalCount: row.total_count,
          lastOutcome: row.last_outcome,
          confidence: row.confidence,
          score,
          matchedBecause:
            row.semantic_id === action.semanticId
              ? `exact semantic match for ${action.semanticId}${row.workspace_root === targets.workspaceRoot ? " in this workspace" : ""}`
              : `same domain and operation with overlapping labels: ${overlapText || "none"}`,
          lesson: lessonFromOutcome(row.last_outcome, row.total_count),
        } satisfies MemoryMatch;
      })
      .filter((match) => match.score >= 0.7)
      .sort((a, b) => b.score - a.score);
  }

  observe(action: ParsedAction, decision: RiskResult["decision"], outcome: ExecutionOutcome | null, workspaceRoot: string): void {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT semantic_id, workspace_root, kind, operation, sample_command, last_outcome, total_count, allow_count, warn_count, block_count, fail_count, confidence, updated_at
         FROM memory_entries WHERE semantic_id = ? AND workspace_root = ?`,
      )
      .get(action.semanticId, workspaceRoot) as MemorySnapshot | undefined;

    const totalCount = (existing?.totalCount ?? 0) + 1;
    const allowCount = (existing?.allowCount ?? 0) + (decision === "allow" ? 1 : 0);
    const warnCount = (existing?.warnCount ?? 0) + (decision === "warn" ? 1 : 0);
    const blockCount = (existing?.blockCount ?? 0) + (decision === "block" ? 1 : 0);
    const failCount = (existing?.failCount ?? 0) + (outcome?.status === "failed" ? 1 : 0);
    const confidence = Math.max(0.1, Math.min(0.99, 1 - (blockCount + failCount) / Math.max(totalCount, 1) * 0.5));
    const lastOutcome = outcome?.status ?? decision;

    this.db.prepare(
      `
        INSERT INTO memory_entries (
          semantic_id, workspace_root, kind, operation, sample_command, last_outcome,
          total_count, allow_count, warn_count, block_count, fail_count, confidence, updated_at
        ) VALUES (
          @semantic_id, @workspace_root, @kind, @operation, @sample_command, @last_outcome,
          @total_count, @allow_count, @warn_count, @block_count, @fail_count, @confidence, @updated_at
        )
        ON CONFLICT(semantic_id, workspace_root) DO UPDATE SET
          kind = excluded.kind,
          operation = excluded.operation,
          sample_command = excluded.sample_command,
          last_outcome = excluded.last_outcome,
          total_count = excluded.total_count,
          allow_count = excluded.allow_count,
          warn_count = excluded.warn_count,
          block_count = excluded.block_count,
          fail_count = excluded.fail_count,
          confidence = excluded.confidence,
          updated_at = excluded.updated_at
      `,
    ).run({
      semantic_id: action.semanticId,
      workspace_root: workspaceRoot,
      kind: action.kind,
      operation: action.operation,
      sample_command: action.redactedCommand,
      last_outcome: lastOutcome,
      total_count: totalCount,
      allow_count: allowCount,
      warn_count: warnCount,
      block_count: blockCount,
      fail_count: failCount,
      confidence,
      updated_at: now,
    });
  }

  list(limit = 50): MemorySnapshot[] {
    return this.db
      .prepare(
        `SELECT semantic_id AS semanticId, workspace_root AS workspaceRoot, kind, operation, sample_command AS sampleCommand,
                last_outcome AS lastOutcome, total_count AS totalCount, allow_count AS allowCount,
                warn_count AS warnCount, block_count AS blockCount, fail_count AS failCount,
                confidence, updated_at AS updatedAt
         FROM memory_entries
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(limit) as MemorySnapshot[];
  }
}

function lessonFromOutcome(lastOutcome: string, totalCount: number): string {
  if (lastOutcome === "blocked") {
    return totalCount > 1 ? "Repeated blocks indicate the action pattern should stay blocked." : "Blocked outcomes should be treated as dangerous by default.";
  }
  if (lastOutcome === "failed") {
    return "Previous execution failed, so the same action should be treated cautiously.";
  }
  if (lastOutcome === "warn") {
    return "This pattern has needed approval before, so expect a human gate.";
  }
  return "This pattern has been safe so far, but still track its blast radius.";
}

function semanticLabels(semanticId: string): Set<string> {
  return new Set(
    semanticId
      .split(".")
      .flatMap((part) => part.split("-"))
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const label of a) {
    if (b.has(label)) {
      shared += 1;
    }
  }
  return shared / Math.max(a.size, b.size);
}
