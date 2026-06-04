import { redactCommand } from "./redact.js";
import { ensureLocalStateDir, getLocalStatePaths, normalizeCommandPattern, readJsonlFile, writeJsonlFile } from "./local-state.js";
import type { LocalMemoryMatch, LocalMemoryRecord } from "./types.js";

let memoryCounter = 0;

export function listLocalMemory(cwd = process.cwd()): LocalMemoryRecord[] {
  return readJsonlFile<LocalMemoryRecord>(getLocalStatePaths(cwd).memoryPath);
}

export function storeLocalMemory(
  type: "safe" | "unsafe",
  command: string,
  cwd = process.cwd(),
  reason?: string,
): LocalMemoryRecord {
  if (!command.trim()) {
    throw new Error(`Missing command for mark-${type}.`);
  }

  const paths = ensureLocalStateDir(cwd);
  const redactedPattern = redactCommand(command.trim());
  const normalizedPattern = normalizeCommandPattern(redactedPattern);
  const existing = readJsonlFile<LocalMemoryRecord>(paths.memoryPath).filter(
    (record) => !(record.type === type && record.normalized_pattern === normalizedPattern),
  );
  const next: LocalMemoryRecord = {
    memory_id: createMemoryId(),
    created_at: new Date().toISOString(),
    type,
    pattern: redactedPattern,
    normalized_pattern: normalizedPattern,
    reason_optional: reason,
    repo_scope: "repo",
    source: "user",
  };

  writeJsonlFile(paths.memoryPath, [...existing, next]);
  return next;
}

export function matchLocalMemory(command: string, cwd = process.cwd()): LocalMemoryMatch[] {
  const normalized = normalizeCommandPattern(redactCommand(command));
  return listLocalMemory(cwd)
    .filter((record) => record.normalized_pattern === normalized)
    .map((record) => ({
      memory_id: record.memory_id,
      type: record.type,
      pattern: record.pattern,
      source: record.source,
    }));
}

export function formatLocalMemoryHuman(records: LocalMemoryRecord[]): string {
  const unsafe = uniquePatterns(records.filter((record) => record.type === "unsafe").map((record) => record.pattern));
  const safe = uniquePatterns(records.filter((record) => record.type === "safe").map((record) => record.pattern));
  return [
    "Termyte Memory",
    "",
    "Unsafe patterns:",
    ...(unsafe.length > 0 ? unsafe.map((pattern) => `- ${pattern}`) : ["- none"]),
    "",
    "Safe patterns:",
    ...(safe.length > 0 ? safe.map((pattern) => `- ${pattern}`) : ["- none"]),
  ].join("\n");
}

function createMemoryId(): string {
  memoryCounter += 1;
  return `mem_${Date.now()}_${memoryCounter}`;
}

function uniquePatterns(patterns: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const pattern of patterns) {
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    unique.push(pattern);
  }
  return unique;
}
