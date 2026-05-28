import type Database from "better-sqlite3";
import type { Decision, ExecutionOutcome, ParsedAction, ResolvedTargets, RuntimeRecord } from "./types.js";
import { describeTargets } from "./resolver.js";
import { redactCommand } from "./redact.js";

export class Ledger {
  constructor(private readonly db: Database.Database) {}

  createPending(action: ParsedAction, targets: ResolvedTargets, envKeys: string[], metadata: Record<string, unknown>): number {
    const redactedCommand = redactCommand(action.rawCommand);
    const stmt = this.db.prepare(`
      INSERT INTO ledger (
        created_at, workspace_root, raw_command, redacted_command, semantic_id, kind, operation,
        decision, risk_score, risk_reason, target_summary, target_count, executed, exit_code,
        stdout, stderr, status, env_keys_json, metadata_json
      ) VALUES (
        @created_at, @workspace_root, @raw_command, @redacted_command, @semantic_id, @kind, @operation,
        'pending', NULL, NULL, @target_summary, @target_count, 0, NULL,
        NULL, NULL, 'planned', @env_keys_json, @metadata_json
      )
    `);

    const result = stmt.run({
      created_at: new Date().toISOString(),
      workspace_root: targets.workspaceRoot,
      raw_command: redactedCommand,
      redacted_command: redactedCommand,
      semantic_id: action.semanticId,
      kind: action.kind,
      operation: action.operation,
      target_summary: describeTargets(targets),
      target_count: targets.targetCount,
      env_keys_json: JSON.stringify(envKeys),
      metadata_json: JSON.stringify(metadata),
    });

    return Number(result.lastInsertRowid);
  }

  finalize(
    id: number,
    decision: Decision,
    outcome: ExecutionOutcome,
    riskScore: number,
    riskReason: string,
  ): void {
    const stmt = this.db.prepare(`
      UPDATE ledger
      SET decision = @decision,
          risk_score = @risk_score,
          risk_reason = @risk_reason,
          executed = @executed,
          exit_code = @exit_code,
          stdout = @stdout,
          stderr = @stderr,
          status = @status
      WHERE id = @id
    `);

    stmt.run({
      id,
      decision,
      risk_score: riskScore,
      risk_reason: riskReason,
      executed: outcome.status === "executed" ? 1 : 0,
      exit_code: outcome.exitCode,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      status: outcome.status,
    });
  }

  listLatest(limit = 50): RuntimeRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        created_at AS createdAt,
        workspace_root AS workspaceRoot,
        raw_command AS rawCommand,
        redacted_command AS redactedCommand,
        semantic_id AS semanticId,
        kind,
        operation,
        decision,
        risk_score AS riskScore,
        risk_reason AS riskReason,
        target_summary AS targetSummary,
        target_count AS targetCount,
        executed,
        exit_code AS exitCode,
        stdout,
        stderr,
        status,
        env_keys_json AS envKeysJson,
        metadata_json AS metadataJson
      FROM ledger
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as RuntimeRecord[];
  }

  replay(): RuntimeRecord[] {
    const stmt = this.db.prepare(`
      SELECT
        id,
        created_at AS createdAt,
        workspace_root AS workspaceRoot,
        raw_command AS rawCommand,
        redacted_command AS redactedCommand,
        semantic_id AS semanticId,
        kind,
        operation,
        decision,
        risk_score AS riskScore,
        risk_reason AS riskReason,
        target_summary AS targetSummary,
        target_count AS targetCount,
        executed,
        exit_code AS exitCode,
        stdout,
        stderr,
        status,
        env_keys_json AS envKeysJson,
        metadata_json AS metadataJson
      FROM ledger
      ORDER BY id ASC
    `);
    return stmt.all() as RuntimeRecord[];
  }

  getById(id: number): RuntimeRecord | undefined {
    return this.db
      .prepare(
        `
        SELECT
          id,
          created_at AS createdAt,
          workspace_root AS workspaceRoot,
          raw_command AS rawCommand,
          redacted_command AS redactedCommand,
          semantic_id AS semanticId,
          kind,
          operation,
          decision,
          risk_score AS riskScore,
          risk_reason AS riskReason,
          target_summary AS targetSummary,
          target_count AS targetCount,
          executed,
          exit_code AS exitCode,
          stdout,
          stderr,
          status,
          env_keys_json AS envKeysJson,
          metadata_json AS metadataJson
        FROM ledger
        WHERE id = ?
      `,
      )
      .get(id) as RuntimeRecord | undefined;
  }
}
