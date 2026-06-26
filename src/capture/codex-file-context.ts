/**
 * Codex-specific file path extraction. The Codex hook fires a PreToolUse
 * event before a `Bash` call lands; we want to tell the observer which
 * files the command is about to read so it can boost file-aware search
 * later. Unlike the generic regex in `files.ts`, this implementation
 * only collects **existing** file paths, uses a real shell-style tokenizer
 * for quoted segments, and respects flag-with-value conventions per
 * command (e.g. `head -n 5`).
 *
 * See claude-mem `src/cli/adapters/codex-file-context.ts`.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const MAX_FILE_PATHS = 10;
const READ_COMMANDS = new Set(["cat", "head", "tail", "less", "more", "bat", "view", "nl", "tac"]);

const FLAGS_WITH_VALUES_BY_COMMAND: Record<string, Set<string>> = {
  head: new Set(["-n", "-c", "--lines", "--bytes"]),
  tail: new Set(["-n", "-c", "--lines", "--bytes"]),
};
const NO_FLAGS_WITH_VALUES = new Set<string>();

function flagsWithValues(command: string): Set<string> {
  return FLAGS_WITH_VALUES_BY_COMMAND[command] ?? NO_FLAGS_WITH_VALUES;
}

function dropFlagValue(flag: string, command: string): boolean {
  const valueFlags = flagsWithValues(command);
  if (valueFlags.has(flag)) return true;
  const eqIndex = flag.indexOf("=");
  return eqIndex > 0 && valueFlags.has(flag.slice(0, eqIndex));
}

function isFlagLike(value: string): boolean {
  return value.startsWith("-") || value.startsWith("+");
}

function isExistingFile(candidate: string, cwd: string): boolean {
  const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(cwd, candidate);
  try {
    if (!existsSync(absolutePath)) return false;
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Tiny shell-tokenizer. Supports single-quoted, double-quoted, and
 * backslash-escaped segments. Does not support process substitution or
 * ANSI-C quoting ($'...') — those are rare in agent-issued commands.
 *
 * Backslashes are only treated as escape characters inside double-quoted
 * regions (POSIX shell semantics). Single-quoted regions preserve every
 * byte verbatim, and unquoted text preserves backslashes — so Windows
 * paths like `C:\Users\foo` pass through unchanged.
 */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote === '"' && c === "\\") {
      const next = command[i + 1];
      if (next === undefined) { current += c; continue; }
      // Inside double quotes, only $, `, ", \, and newline are escape-worthy.
      if (next === "$" || next === "`" || next === '"' || next === "\\" || next === "\n") {
        current += next;
        i++;
        continue;
      }
      current += c;
      continue;
    }
    if (quote) {
      if (c === quote) { quote = null; continue; }
      current += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (/\s/.test(c)) {
      if (current.length > 0) { tokens.push(current); current = ""; }
      continue;
    }
    current += c;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/** Split a token list on `;`, `|`, `&&`, `||` so each pipeline is
 *  classified independently. */
function splitSegments(tokens: string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  const ops = new Set([";", "|", "&&", "||"]);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (ops.has(t)) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    // `2>&1`, `&` background, etc. — split, drop the operator.
    if (t === "&" || t.startsWith("&")) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function normalizeCommand(command: unknown): string | null {
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    const parts = command.filter((p): p is string => typeof p === "string");
    return parts.length > 0 ? parts.join(" ") : null;
  }
  return null;
}

function dedupeAndCap(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_FILE_PATHS) break;
  }
  return out;
}

function extractFromBash(toolInput: unknown, cwd: string): string[] {
  const command = normalizeCommand((toolInput as { command?: unknown } | undefined)?.command);
  if (!command) return [];

  const tokens = tokenize(command);
  const paths: string[] = [];

  for (const segment of splitSegments(tokens)) {
    const argv0Index = segment.findIndex((t) => t && !isFlagLike(t));
    if (argv0Index === -1) continue;
    const argv0 = path.basename(segment[argv0Index]!);
    if (!READ_COMMANDS.has(argv0)) continue;

    let skipNext = false;
    for (const token of segment.slice(argv0Index + 1)) {
      if (skipNext) { skipNext = false; continue; }
      if (isFlagLike(token)) {
        skipNext = dropFlagValue(token, argv0) && !token.includes("=");
        continue;
      }
      if (isExistingFile(token, cwd)) paths.push(token);
    }
  }

  return dedupeAndCap(paths);
}

function extractFromMcp(toolName: string, toolInput: unknown, cwd: string): string[] {
  if (!/^mcp__.+__(read|view|cat)(?:_file|_files)?$/.test(toolName)) return [];
  const input = (toolInput ?? {}) as { path?: unknown; paths?: unknown };
  const candidates: string[] = [];
  if (typeof input.path === "string") candidates.push(input.path);
  if (Array.isArray(input.paths)) {
    for (const item of input.paths) {
      if (typeof item === "string") candidates.push(item);
    }
  }
  return dedupeAndCap(candidates.filter((c) => isExistingFile(c, cwd)));
}

export function extractCodexFilePaths(
  toolName: string,
  toolInput: unknown,
  cwd: string,
): string[] {
  if (toolName === "Bash") return extractFromBash(toolInput, cwd);
  if (toolName.startsWith("mcp__")) return extractFromMcp(toolName, toolInput, cwd);
  return [];
}
