import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureLocalStateDir, getLocalStatePaths, normalizeCommandPattern } from "./local-state.js";
import { redactCommand } from "./redact.js";

export interface LocalApprovalRecord {
  approval_id: string;
  created_at: string;
  used_at: string | null;
  expires_at: string;
  command: string;
  normalized_command: string;
  fingerprint: string;
  repo_scope: "repo";
  source: "user";
  reason_optional?: string;
}

interface LocalApprovalStore {
  version: 1;
  approvals: LocalApprovalRecord[];
}

let approvalCounter = 0;

export function listLocalApprovals(cwd = process.cwd()): LocalApprovalRecord[] {
  return readStore(cwd).approvals;
}

export function storeLocalApproval(command: string, cwd = process.cwd(), ttlMinutes = 30, reason?: string): LocalApprovalRecord {
  if (!command.trim()) {
    throw new Error("Missing command for allow-once.");
  }

  const paths = ensureLocalStateDir(cwd);
  const store = readStore(cwd);
  const now = new Date();
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  const redacted = redactCommand(command.trim());
  const normalized = normalizeCommandPattern(redacted);
  const fingerprint = fingerprintFor(cwd, normalized);
  const next: LocalApprovalRecord = {
    approval_id: createApprovalId(),
    created_at: createdAt,
    used_at: null,
    expires_at: expiresAt,
    command: redacted,
    normalized_command: normalized,
    fingerprint,
    repo_scope: "repo",
    source: "user",
    reason_optional: reason,
  };

  const approvals = store.approvals.filter((record) => record.fingerprint !== fingerprint || record.used_at !== null);
  writeStore(paths.approvalsPath, { version: 1, approvals: [...approvals, next] });
  return next;
}

export function findMatchingApproval(command: string, cwd = process.cwd()): LocalApprovalRecord | null {
  const store = readStore(cwd);
  const fingerprint = fingerprintFor(cwd, normalizeCommandPattern(redactCommand(command)));
  const now = Date.now();
  return store.approvals.find((record) => {
    if (record.fingerprint !== fingerprint) return false;
    if (record.used_at) return false;
    return Date.parse(record.expires_at) > now;
  }) ?? null;
}

export function consumeMatchingApproval(command: string, cwd = process.cwd()): LocalApprovalRecord | null {
  const paths = ensureLocalStateDir(cwd);
  const store = readStore(cwd);
  const fingerprint = fingerprintFor(cwd, normalizeCommandPattern(redactCommand(command)));
  const now = Date.now();
  const index = store.approvals.findIndex((record) => {
    if (record.fingerprint !== fingerprint) return false;
    if (record.used_at) return false;
    return Date.parse(record.expires_at) > now;
  });

  if (index === -1) {
    return null;
  }

  const consumed = {
    ...store.approvals[index],
    used_at: new Date().toISOString(),
  };
  store.approvals[index] = consumed;
  writeStore(paths.approvalsPath, store);
  return consumed;
}

export function formatLocalApprovalsHuman(records: LocalApprovalRecord[]): string {
  if (records.length === 0) {
    return "Termyte approvals\n\nNo approvals yet.";
  }

  return [
    "Termyte approvals",
    "",
    ...records.flatMap((record) => {
      const lines = [
        `${record.used_at ? "[USED]" : "[PENDING]"} ${record.command}`,
        `Fingerprint: ${record.fingerprint.slice(0, 12)}`,
        `Expires: ${new Date(record.expires_at).toLocaleString()}`,
      ];
      if (record.reason_optional) {
        lines.push(`Reason: ${record.reason_optional}`);
      }
      return lines;
    }),
  ].join("\n");
}

function readStore(cwd = process.cwd()): LocalApprovalStore {
  const filePath = getLocalStatePaths(cwd).approvalsPath;
  if (!fs.existsSync(filePath)) {
    return { version: 1, approvals: [] };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      return { version: 1, approvals: [] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { version: 1, approvals: [] };
    }
    const approvals = Array.isArray((parsed as { approvals?: unknown }).approvals)
      ? ((parsed as { approvals: LocalApprovalRecord[] }).approvals ?? [])
      : [];
    return { version: 1, approvals };
  } catch {
    return { version: 1, approvals: [] };
  }
}

function writeStore(filePath: string, store: LocalApprovalStore): void {
  fs.writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function fingerprintFor(cwd: string, normalizedCommand: string): string {
  return crypto
    .createHash("sha256")
    .update(`${path.resolve(cwd).toLowerCase()}::${normalizedCommand}`)
    .digest("hex");
}

function createApprovalId(): string {
  approvalCounter += 1;
  return `apr_${Date.now()}_${approvalCounter}`;
}
