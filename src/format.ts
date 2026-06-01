import type { InspectionReport, MemoryMatch, ReplayEntry } from "./types.js";
import type { MemorySnapshot } from "./memory.js";
import type { RuntimeRecord } from "./types.js";

export function formatTable(rows: Array<Record<string, string | number | null>>): string {
  if (rows.length === 0) {
    return "(empty)";
  }

  const headers = Object.keys(rows[0] ?? {});
  const widths = headers.map((header) => Math.max(header.length, ...rows.map((row) => String(row[header] ?? "").length)));
  const lines: string[] = [];

  lines.push(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  lines.push(widths.map((width) => "-".repeat(width)).join("  "));

  for (const row of rows) {
    lines.push(headers.map((header, index) => String(row[header] ?? "").padEnd(widths[index])).join("  "));
  }

  return lines.join("\n");
}

export function formatLedger(records: RuntimeRecord[]): string {
  return formatTable(
    records.map((record) => {
      const metadata = safeParseMetadata(record.metadataJson);
      return {
        id: record.id,
        createdAt: record.createdAt,
        decision: record.decision,
        status: record.status,
        exit: record.exitCode,
        runtime: metadata.runtime ?? "",
        launchedVia: metadata.launchedVia ?? "",
        agent: metadata.agentName ?? "",
        profile: metadata.runtimeProfile ?? "",
        correlation: shortCorrelationId(metadata.commandCorrelationId),
        semanticId: record.semanticId,
        command: record.redactedCommand,
        reason: metadata.recoveryReason ?? record.riskReason ?? "",
      };
    }),
  );
}

function parseMemoryMatches(metadataJson: string | null | undefined): MemoryMatch[] {
  if (!metadataJson) return [];
  try {
    const parsed = JSON.parse(metadataJson) as { memoryMatches?: MemoryMatch[] };
    return Array.isArray(parsed.memoryMatches) ? parsed.memoryMatches : [];
  } catch {
    return [];
  }
}

function safeParseMetadata(metadataJson: string | null | undefined): {
  targets?: { expandedTargets?: string[]; targetCount?: number };
  risk?: { score?: number; reason?: string };
  memoryMatches?: MemoryMatch[];
  runtime?: string;
  launchedVia?: string;
  agentName?: string;
  runtimeProfile?: string;
  recovered?: boolean;
  recoveryReason?: string;
  executionError?: string;
  commandCorrelationId?: string;
  enabledShims?: string[];
  disabledShims?: string[];
  shellHooksEnabled?: boolean;
  shellHookStrategy?: string;
  knownCompatibilityNotes?: string[];
  runtimeWarnings?: string[];
} {
  if (!metadataJson) return {};
  try {
    return JSON.parse(metadataJson) as {
      targets?: { expandedTargets?: string[]; targetCount?: number };
      risk?: { score?: number; reason?: string };
      memoryMatches?: MemoryMatch[];
      runtime?: string;
      launchedVia?: string;
      agentName?: string;
      runtimeProfile?: string;
      recovered?: boolean;
      recoveryReason?: string;
      executionError?: string;
      commandCorrelationId?: string;
      enabledShims?: string[];
      disabledShims?: string[];
      shellHooksEnabled?: boolean;
      shellHookStrategy?: string;
      knownCompatibilityNotes?: string[];
      runtimeWarnings?: string[];
    };
  } catch {
    return {};
  }
}

function summaryFromMemoryMatches(matches: MemoryMatch[]): string {
  if (matches.length === 0) return "none";
  return matches
    .map((match) => `${match.memoryId}:${match.semanticId} (${match.lastOutcome}, score ${match.score.toFixed(2)}, confidence ${match.confidence.toFixed(2)}, fp ${match.falsePositiveCount})`)
    .join("; ");
}

export function replayEntries(records: RuntimeRecord[]): ReplayEntry[] {
  return records.map((record) => {
    const metadata = safeParseMetadata(record.metadataJson);
    const memoryMatches = parseMemoryMatches(record.metadataJson);
    const targets = metadata.targets?.expandedTargets ?? [];
    return {
      timestamp: record.createdAt,
      action: record.redactedCommand,
      runtime: metadata.runtime,
      launchedVia: metadata.launchedVia,
      agentName: metadata.agentName,
      runtimeProfile: metadata.runtimeProfile,
      commandCorrelationId: metadata.commandCorrelationId,
      semanticMeaning: record.semanticId,
      blastRadius: {
        score: metadata.risk?.score ?? record.riskScore,
        reason: metadata.risk?.reason ?? record.riskReason,
        targets: targets.length > 0 ? targets.join(", ") : record.targetSummary,
      },
      memoryMatches,
      finalDecision: record.decision,
      outcome:
        record.status === "executed"
          ? `executed (exit ${record.exitCode ?? 0})`
          : record.status === "failed"
            ? metadata.recovered && metadata.recoveryReason
              ? `failed (recovered: ${metadata.recoveryReason})`
              : metadata.executionError
                ? `failed (${metadata.executionError})`
              : `failed (exit ${record.exitCode ?? "n/a"})`
            : record.status,
    };
  });
}

export function formatReplay(records: RuntimeRecord[]): string {
  const entries = replayEntries(records);
  if (entries.length === 0) return "(empty)";

  const grouped: string[] = [];
  const consumed = new Set<number>();
  for (let index = 0; index < entries.length; index += 1) {
    if (consumed.has(index)) continue;
    const entry = entries[index];
    const correlationId = entry.commandCorrelationId;
    if (correlationId) {
      const group = entries
        .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
        .filter(({ candidate, candidateIndex }) => !consumed.has(candidateIndex) && candidate.commandCorrelationId === correlationId);
      for (const { candidateIndex } of group) consumed.add(candidateIndex);
      if (group.length > 1) {
        grouped.push(formatCorrelatedReplayGroup(correlationId, group.map(({ candidate }) => candidate)));
        continue;
      }
    }
    consumed.add(index);
    grouped.push(formatReplayEntry(entry));
  }

  return grouped.join("\n\n");
}

function formatCorrelatedReplayGroup(correlationId: string, entries: ReplayEntry[]): string {
  const lines = [
    `${entries[0]?.timestamp ?? ""}  CORRELATED ACTION  ${shortCorrelationId(correlationId)}`,
  ];
  const first = entries[0];
  if (first?.agentName) {
    lines.push(`  agent: ${first.agentName}${first.runtimeProfile ? ` (${first.runtimeProfile})` : ""}`);
  }
  for (const entry of entries) {
    lines.push(
      `  ${entry.runtime ?? "runtime"}: ${entry.finalDecision.toUpperCase()} ${entry.outcome}`,
      `    action: ${entry.action}`,
      `    semantic: ${entry.semanticMeaning}`,
      `    blast radius: ${entry.blastRadius.score ?? "n/a"} (${entry.blastRadius.reason ?? "n/a"})`,
      `    targets: ${entry.blastRadius.targets}`,
      `    memory: ${summaryFromMemoryMatches(entry.memoryMatches)}`,
    );
  }
  return lines.join("\n");
}

function formatReplayEntry(entry: ReplayEntry): string {
  const runtime = entry.runtime ? `  ${entry.runtime}` : "";
  const lines = [
    `${entry.timestamp}  ${entry.finalDecision.toUpperCase()}  ${entry.outcome}${runtime}`,
  ];
  if (entry.agentName) {
    lines.push(`  agent: ${entry.agentName}${entry.runtimeProfile ? ` (${entry.runtimeProfile})` : ""}`);
  }
  lines.push(
    `  action: ${entry.action}`,
    `  semantic: ${entry.semanticMeaning}`,
    `  blast radius: ${entry.blastRadius.score ?? "n/a"} (${entry.blastRadius.reason ?? "n/a"})`,
    `  targets: ${entry.blastRadius.targets}`,
    `  memory: ${summaryFromMemoryMatches(entry.memoryMatches)}`,
  );
  if (entry.commandCorrelationId) {
    lines.splice(1, 0, `  correlation: ${shortCorrelationId(entry.commandCorrelationId)}`);
  }
  return lines.join("\n");
}

function shortCorrelationId(value: string | undefined): string {
  return value ? value.slice(0, 12) : "";
}

function formatMemoryMatches(matches: MemoryMatch[]): string {
  if (matches.length === 0) return "  - none";
  return matches
    .map((match) => [
      `  - memory id: ${match.memoryId}`,
      `  - semantic: ${match.semanticId}`,
      `    score: ${match.score.toFixed(2)}`,
      `    why: ${match.matchedBecause}`,
      `    previous outcome: ${match.lastOutcome}`,
      `    false positives: ${match.falsePositiveCount}`,
      `    confidence: ${match.confidence.toFixed(2)}`,
      `    lesson: ${match.lesson}`,
    ].join("\n"))
    .join("\n");
}

function formatInspectionSection(title: string, body: string): string {
  return `${title}\n${body}`;
}

export function formatInspection(report: InspectionReport): string {
  const sections = [
    formatInspectionSection(
      "Parsed Semantic Action",
      `  - semantic: ${report.action.semanticId}\n  - kind: ${report.action.kind}\n  - operation: ${report.action.operation}\n  - shell: ${report.action.shell}\n  - command: ${report.action.redactedCommand}`,
    ),
    formatInspectionSection(
      "Resolved Targets",
      `  - target kind: ${report.targets.targetKind}\n  - target count: ${report.targets.targetCount}\n  - inside workspace: ${report.targets.insideWorkspace}\n  - recoverability: ${report.targets.recoverability}\n  - protected targets: ${report.targets.protectedTargets.length > 0 ? report.targets.protectedTargets.join(", ") : "none"}\n  - sensitive targets: ${report.targets.sensitiveTargets.length > 0 ? report.targets.sensitiveTargets.join(", ") : "none"}\n  - expanded targets: ${report.targets.expandedTargets.length > 0 ? report.targets.expandedTargets.join(", ") : "none"}`,
    ),
    formatInspectionSection(
      "Blast Radius",
      `  - score: ${report.risk.score}\n  - reason: ${report.risk.reason}\n  - signals: ${report.risk.signals.length > 0 ? report.risk.signals.join(", ") : "none"}`,
    ),
    formatInspectionSection(
      "Memory Matches",
      formatMemoryMatches(report.memoryMatches),
    ),
    formatInspectionSection(
      "Final Decision",
      `  - policy decision: ${report.policy.decision}\n  - final decision: ${report.finalDecision}\n  - reasoning: ${report.finalReason}`,
    ),
  ];

  return sections.join("\n\n");
}

export function formatMemory(rows: MemorySnapshot[]): string {
  return formatTable(
    rows.map((row) => ({
      memoryId: row.memoryId,
      semanticId: row.semanticId,
      outcome: row.lastOutcome,
      total: row.totalCount,
      allow: row.allowCount,
      warn: row.warnCount,
      block: row.blockCount,
      fail: row.failCount,
      falsePos: row.falsePositiveCount,
      confidence: row.confidence.toFixed(2),
      command: row.sampleCommand,
    })),
  );
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
