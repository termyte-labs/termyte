/**
 * File path extraction from tool input/output. One implementation, shared by
 * every adapter, so the rules for what counts as "read" vs "modified" are
 * consistent across Claude Code, Codex, OpenCode, and Cursor.
 */

export interface ExtractedFiles {
  read: string[];
  modified: string[];
}

const READ_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoRead",
]);

const MODIFY_TOOLS = new Set([
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "DeleteFile",
  "MoveFile",
  "RenameFile",
  "ApplyPatch",
]);

/** Best-effort extraction. Returns an empty object when nothing is found. */
export function extractFilesFromEvent(
  toolName: string,
  input: unknown,
  _output?: unknown,
): ExtractedFiles {
  const read = new Set<string>();
  const modified = new Set<string>();

  if (!isObject(input)) return files(read, modified);

  if (READ_TOOLS.has(toolName)) {
    collectPathLikeField(input, read);
  } else if (MODIFY_TOOLS.has(toolName)) {
    collectPathLikeField(input, modified);
  } else if (toolName === "Bash" || toolName === "bash" || toolName === "shell" || toolName === "run_command") {
    const cmd = pickString(input, ["command", "cmd", "script"]);
    if (cmd) extractBashPaths(cmd, read);
  } else {
    // Unknown tool: try both buckets so we don't lose information.
    collectPathLikeField(input, read);
  }

  return files(read, modified);
}

function files(read: Set<string>, modified: Set<string>): ExtractedFiles {
  return { read: Array.from(read), modified: Array.from(modified) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function collectPathLikeField(input: Record<string, unknown>, sink: Set<string>): void {
  const candidates = [
    input["file_path"],
    input["filePath"],
    input["path"],
    input["notebook_path"],
    input["notebookPath"],
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) sink.add(c);
  }
  const edits = input["edits"];
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (isObject(e)) {
        const p = (e as any)["file_path"] ?? (e as any)["filePath"];
        if (typeof p === "string" && p.length > 0) sink.add(p);
      }
    }
  }
  const pattern = input["pattern"];
  if (typeof pattern === "string" && pattern.length > 0) sink.add(pattern);
}

/**
 * Pull file-path-looking tokens out of a shell command. Intentionally
 * conservative: we only match after common "read" verbs, redirections, and
 * common ripgrep/grep/find invocations.
 */
function extractBashPaths(cmd: string, sink: Set<string>): void {
  // Quoted and unquoted forms.
  const verbs = [
    "cat", "head", "tail", "less", "more", "bat", "view", "nl",
    "vi", "vim", "nano", "emacs", "sed", "awk",
    "grep", "rg", "egrep", "fgrep",
    "find", "fd",
  ];
  for (const verb of verbs) {
    const re = new RegExp(`(?:^|\\s|;|\\|)${verb}\\s+(?:"([^"]+)"|'([^']+)'|(\\S+))`, "g");
    for (const m of cmd.matchAll(re)) {
      const path = m[1] ?? m[2] ?? m[3];
      if (path && !path.startsWith("-")) sink.add(path);
    }
  }
  // Redirections: > path and < path.
  for (const m of cmd.matchAll(/>\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path) sink.add(path);
  }
  for (const m of cmd.matchAll(/<\s*(?:"([^"]+)"|'([^']+)'|(\S+))/g)) {
    const path = m[1] ?? m[2] ?? m[3];
    if (path) sink.add(path);
  }
}
