import fs from "node:fs";
import path from "node:path";
import { defaultDbPath, openDatabase } from "./db.js";
import { replayEntries } from "./format.js";
import { Ledger } from "./ledger.js";
import { runRuntime, type RuntimeResult } from "./runtime.js";

export interface RuntimeProofOptions {
  cwd?: string;
  dbPath?: string;
}

export interface RuntimeProofCheck {
  id: string;
  label: string;
  status: "PASS" | "WARN" | "FAIL";
  message: string;
  details?: Record<string, unknown>;
}

export interface RuntimeProofReport {
  generatedAt: string;
  workspaceRoot: string;
  dbPath: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: RuntimeProofCheck[];
}

function commandForAllowedSmoke(proofDir: string): string {
  if (process.platform === "win32") {
    return `Get-ChildItem -LiteralPath '${proofDir.replace(/'/g, "''")}'`;
  }
  return `ls '${proofDir.replace(/'/g, `'\\''`)}'`;
}

function commandForBlockedDelete(proofDir: string): string {
  if (process.platform === "win32") {
    return `Remove-Item -Recurse -Force '${path.join(proofDir, "*").replace(/'/g, "''")}'`;
  }
  return `rm -rf '${path.join(proofDir, "*").replace(/'/g, `'\\''`)}'`;
}

function checkFromRuntime(id: string, label: string, result: RuntimeResult, expectedDecision: string, expectedExecuted: boolean): RuntimeProofCheck {
  const ok = result.decision === expectedDecision && result.wasExecuted === expectedExecuted;
  return {
    id,
    label,
    status: ok ? "PASS" : "FAIL",
    message: ok
      ? `${result.semanticId} produced ${result.decision} and ${result.wasExecuted ? "executed" : "did not execute"}.`
      : `Expected decision=${expectedDecision} executed=${expectedExecuted}; got decision=${result.decision} executed=${result.wasExecuted}.`,
    details: {
      ledgerId: result.ledgerId,
      semanticId: result.semanticId,
      decision: result.decision,
      wasExecuted: result.wasExecuted,
      exitCode: result.exitCode,
      reason: result.reason,
    },
  };
}

function summarize(checks: RuntimeProofCheck[]): RuntimeProofReport["summary"] {
  return {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
}

export async function runRuntimeProof(options: RuntimeProofOptions = {}): Promise<RuntimeProofReport> {
  const workspaceRoot = path.resolve(options.cwd ?? process.cwd());
  const dbPath = options.dbPath ?? defaultDbPath(workspaceRoot);
  const proofDir = path.join(workspaceRoot, ".termyte", "runtime-proof");
  const sentinelPath = path.join(proofDir, "keep.txt");
  fs.mkdirSync(proofDir, { recursive: true });
  fs.writeFileSync(sentinelPath, "termyte proof sentinel\n", "utf8");

  const env = { ...process.env };
  const checks: RuntimeProofCheck[] = [];

  const allowed = await runRuntime({
    command: commandForAllowedSmoke(proofDir),
    cwd: workspaceRoot,
    dbPath,
    approval: async () => false,
    env,
  });
  checks.push(checkFromRuntime("allowed.read", "Allowed read command", allowed, "allow", true));

  const forcePush = await runRuntime({
    command: "git push --force origin main",
    cwd: workspaceRoot,
    dbPath,
    approval: async () => false,
    env,
  });
  checks.push(checkFromRuntime("blocked.force_push", "Force push to main", forcePush, "block", false));

  const deleteResult = await runRuntime({
    command: commandForBlockedDelete(proofDir),
    cwd: workspaceRoot,
    dbPath,
    approval: async () => false,
    env,
  });
  checks.push(checkFromRuntime("blocked.delete", "Recursive force delete", deleteResult, "block", false));

  const sentinelStillExists = fs.existsSync(sentinelPath);
  checks.push({
    id: "side_effect.delete_prevented",
    label: "Blocked delete side effect",
    status: sentinelStillExists ? "PASS" : "FAIL",
    message: sentinelStillExists ? "Sentinel file still exists after blocked delete." : "Sentinel file was removed; blocked delete did not protect the filesystem.",
    details: { sentinelPath },
  });

  const secretRead = await runRuntime({
    command: process.platform === "win32" ? "Get-Content .env" : "cat .env",
    cwd: workspaceRoot,
    dbPath,
    approval: async () => false,
    env,
  });
  checks.push({
    id: "warn.secret_read",
    label: "Secret read requires approval",
    status: secretRead.decision === "warn" && !secretRead.wasExecuted ? "PASS" : "FAIL",
    message: secretRead.decision === "warn" && !secretRead.wasExecuted
      ? "Secret-looking read was warned and did not execute without approval."
      : `Expected warn without execution; got decision=${secretRead.decision} executed=${secretRead.wasExecuted}.`,
    details: {
      ledgerId: secretRead.ledgerId,
      semanticId: secretRead.semanticId,
      decision: secretRead.decision,
      wasExecuted: secretRead.wasExecuted,
      reason: secretRead.reason,
    },
  });

  const ledger = new Ledger(openDatabase(dbPath).db);
  const replay = replayEntries(ledger.replay());
  const requiredLedgerIds = new Set([allowed.ledgerId, forcePush.ledgerId, deleteResult.ledgerId, secretRead.ledgerId]);
  const replayLedgerIds = new Set(ledger.replay().map((record) => record.id));
  const hasAllRecords = [...requiredLedgerIds].every((id) => replayLedgerIds.has(id));
  checks.push({
    id: "ledger.records",
    label: "Replay ledger",
    status: hasAllRecords ? "PASS" : "FAIL",
    message: hasAllRecords ? "Replay ledger contains all proof decisions." : "Replay ledger is missing one or more proof decisions.",
    details: {
      requiredLedgerIds: [...requiredLedgerIds],
      recentReplayCount: replay.length,
    },
  });

  checks.push({
    id: "boundary.raw_runtime",
    label: "Raw runtime boundary",
    status: "WARN",
    message: "MCP tools and Termyte runtime commands are governed. Raw agent-native tools, direct syscalls, and unsupported subprocess paths still require hooks or sandboxing.",
  });

  return {
    generatedAt: new Date().toISOString(),
    workspaceRoot,
    dbPath,
    summary: summarize(checks),
    checks,
  };
}

export function formatRuntimeProofHuman(report: RuntimeProofReport): string {
  const lines = [
    "Termyte Runtime Proof",
    "",
    `Workspace: ${report.workspaceRoot}`,
    `Database: ${report.dbPath}`,
    "",
    `Summary: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)} ${check.label}`);
    lines.push(`     ${check.message}`);
  }
  return lines.join("\n");
}

