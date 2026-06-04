import fs from "node:fs";
import path from "node:path";

export interface LocalStatePaths {
  cwd: string;
  repo: string;
  stateDir: string;
  logsPath: string;
  memoryPath: string;
}

export function getLocalStatePaths(cwd = process.cwd()): LocalStatePaths {
  const resolvedCwd = path.resolve(cwd);
  const repo = path.basename(resolvedCwd);
  const stateDir = path.join(resolvedCwd, ".termyte");
  return {
    cwd: resolvedCwd,
    repo,
    stateDir,
    logsPath: path.join(stateDir, "logs.jsonl"),
    memoryPath: path.join(stateDir, "memory.jsonl"),
  };
}

export function ensureLocalStateDir(cwd = process.cwd()): LocalStatePaths {
  const paths = getLocalStatePaths(cwd);
  fs.mkdirSync(paths.stateDir, { recursive: true });
  return paths;
}

export function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  if (!content.trim()) {
    return [];
  }

  const rows: T[] = [];
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    rows.push(JSON.parse(trimmed) as T);
  }
  return rows;
}

export function writeJsonlFile<T>(filePath: string, rows: T[]): void {
  const output = rows.length > 0 ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
  fs.writeFileSync(filePath, output, "utf8");
}

export function appendJsonlRow<T>(filePath: string, row: T): void {
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

export function normalizeCommandPattern(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}
