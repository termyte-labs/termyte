import type Database from "better-sqlite3";
import type { Decision, ExecutionOutcome, ParsedAction, ResolvedTargets, RuntimeRecord } from "./types.js";
import { describeTargets } from "./resolver.js";
import { redactCommand } from "./redact.js";

export class Ledger {
  constructor(private readonly db: Database.Database) {}

  createPending(action: ParsedAction, targets: ResolvedTargets, envKeys: string[], metadata: Record<string, unknown>): number {
    return this.insertLedgerRow(action, targets, envKeys, metadata, "pending", "planned");
  }

  createHookRecord(
    action: ParsedAction,
    targets: ResolvedTargets,
    envKeys: string[],
    metadata: Record<string, unknown>,
    decision: Decision | "pending",
    status: "planned" | "blocked" | "executed" | "failed" = "planned",
  ): number {
    return this.insertLedgerRow(action, targets, envKeys, metadata, decision, status);
  }

  finalize(
    id: number,
    decision: Decision,
    outcome: ExecutionOutcome,
    riskScore: number,
    riskReason: string,
    metadata?: Record<string, unknown>,
  ): void {
    const existing = metadata ? this.getById(id) : undefined;
    const metadataJson = metadata
      ? JSON.stringify({
          ...(existing?.metadataJson ? safeParseJson(existing.metadataJson) : {}),
          ...metadata,
        })
      : undefined;
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
          ${metadata ? ", metadata_json = @metadata_json" : ""}
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
      metadata_json: metadataJson,
    });
  }

  updateShellShimHeartbeat(id: number, heartbeat: {
    pid?: number;
    sessionId: string;
    lastHeartbeatAt: string;
    heartbeatIntervalMs: number;
  }): boolean {
    const existing = this.getById(id);
    if (!existing || existing.decision !== "pending" || existing.status !== "planned") {
      return false;
    }

    const metadata = safeParseJson(existing.metadataJson);
    if (metadata.runtime !== "shell-shim" && metadata.shimRuntime !== true) {
      return false;
    }

    this.db.prepare(
      `
      UPDATE ledger
      SET metadata_json = @metadata_json
      WHERE id = @id
        AND decision = 'pending'
        AND status = 'planned'
      `,
    ).run({
      id,
      metadata_json: JSON.stringify({
        ...metadata,
        pid: heartbeat.pid,
        sessionId: heartbeat.sessionId,
        lastHeartbeatAt: heartbeat.lastHeartbeatAt,
        heartbeatIntervalMs: heartbeat.heartbeatIntervalMs,
        runtime: "shell-shim",
        shimRuntime: true,
      }),
    });

    return true;
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

  findLatestByMetadataKey(key: string, value: string): RuntimeRecord | undefined {
    return this.listLatest(200).find((row) => {
      const metadata = safeParseJson(row.metadataJson);
      return typeof metadata[key] === "string" && metadata[key] === value;
    });
  }

  recoverStaleShellShimPending(options: {
    workspaceRoot: string;
    activeSessionId: string;
    staleMs: number;
    now?: Date;
  }): number {
    const now = options.now ?? new Date();
    const rows = this.db
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
        WHERE workspace_root = ?
          AND decision = 'pending'
          AND status = 'planned'
      `,
      )
      .all(options.workspaceRoot) as RuntimeRecord[];

    let recovered = 0;
    for (const row of rows) {
      const metadata = safeParseJson(row.metadataJson);
      if (metadata.runtime !== "shell-shim" && metadata.shimRuntime !== true) {
        continue;
      }
      if (metadata.sessionId === options.activeSessionId) {
        continue;
      }

      const startedAt = typeof metadata.startedAt === "string" ? Date.parse(metadata.startedAt) : Date.parse(row.createdAt);
      const heartbeatAt = typeof metadata.lastHeartbeatAt === "string" ? Date.parse(metadata.lastHeartbeatAt) : NaN;
      const livenessAt = Number.isFinite(heartbeatAt) ? heartbeatAt : startedAt;
      if (!Number.isFinite(livenessAt) || now.getTime() - livenessAt < options.staleMs) {
        continue;
      }

      const startBasis = Number.isFinite(startedAt) ? startedAt : livenessAt;
      const durationMs = Math.max(0, now.getTime() - startBasis);
      const finalDecision = isDecision(metadata.finalDecision) ? metadata.finalDecision : "allow";
      const risk = safeObject(metadata.risk);
      const riskScore = typeof risk.score === "number" ? risk.score : row.riskScore ?? 0;
      const riskReason = typeof risk.reason === "string" ? risk.reason : row.riskReason ?? "guard daemon terminated before shim finalization";
      const executionError = Number.isFinite(heartbeatAt)
        ? "shell_shim_heartbeat_stale_before_finalize"
        : "guard_daemon_terminated_before_finalize";
      const mergedMetadata = {
        ...metadata,
        endedAt: now.toISOString(),
        durationMs,
        executionError,
        recovered: true,
        recoveredAt: now.toISOString(),
        recoveryReason: executionError,
      };

      this.db.prepare(
        `
        UPDATE ledger
        SET decision = @decision,
            risk_score = @risk_score,
            risk_reason = @risk_reason,
            executed = 0,
            exit_code = NULL,
            stdout = '',
            stderr = @stderr,
            status = 'failed',
            metadata_json = @metadata_json
        WHERE id = @id
      `,
      ).run({
        id: row.id,
        decision: finalDecision,
        risk_score: riskScore,
        risk_reason: riskReason,
        stderr: `${executionError}\n`,
        metadata_json: JSON.stringify(mergedMetadata),
      });
      recovered += 1;
    }

    return recovered;
  }

  private insertLedgerRow(
    action: ParsedAction,
    targets: ResolvedTargets,
    envKeys: string[],
    metadata: Record<string, unknown>,
    decision: Decision | "pending",
    status: "planned" | "blocked" | "executed" | "failed",
  ): number {
    const redactedCommand = redactCommand(action.rawCommand);
    const stmt = this.db.prepare(`
      INSERT INTO ledger (
        created_at, workspace_root, raw_command, redacted_command, semantic_id, kind, operation,
        decision, risk_score, risk_reason, target_summary, target_count, executed, exit_code,
        stdout, stderr, status, env_keys_json, metadata_json
      ) VALUES (
        @created_at, @workspace_root, @raw_command, @redacted_command, @semantic_id, @kind, @operation,
        @decision, NULL, NULL, @target_summary, @target_count, @executed, NULL,
        NULL, NULL, @status, @env_keys_json, @metadata_json
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
      decision,
      target_summary: describeTargets(targets),
      target_count: targets.targetCount,
      executed: status === "executed" ? 1 : 0,
      status,
      env_keys_json: JSON.stringify(envKeys),
      metadata_json: JSON.stringify(metadata),
    });

    return Number(result.lastInsertRowid);
  }
}

function safeParseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isDecision(value: unknown): value is Decision {
  return value === "allow" || value === "warn" || value === "block";
}
