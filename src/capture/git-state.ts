import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface GitDiffState {
  head: string | null;
  changedPaths: string[];
  stagedPaths: string[];
  unstagedPaths: string[];
  untrackedPaths: string[];
  stagedStat: string | null;
  unstagedStat: string | null;
}

export interface RepositoryState extends GitDiffState {
  branch: string | null;
  conflicts: string[];
}

export interface GitStateOptions {
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 500;

export function readGitHead(workspaceRoot: string, options: GitStateOptions = {}): string | null {
  const output = runGit(workspaceRoot, ["rev-parse", "--verify", "HEAD"], options.timeoutMs);
  const head = output?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
}

export function readGitDiffState(workspaceRoot: string, options: GitStateOptions = {}): GitDiffState | null {
  const head = readGitHead(workspaceRoot, options);
  if (!head) return null;

  const stagedPaths = readPaths(workspaceRoot, ["diff", "--cached", "--name-only", "-z", "--no-ext-diff"], options);
  const unstagedPaths = readPaths(workspaceRoot, ["diff", "--name-only", "-z", "--no-ext-diff"], options);
  const untrackedPaths = readPaths(workspaceRoot, ["ls-files", "--others", "--exclude-standard", "-z"], options);
  if (stagedPaths === null || unstagedPaths === null || untrackedPaths === null) return null;

  return {
    head,
    stagedPaths,
    unstagedPaths,
    untrackedPaths,
    changedPaths: [...new Set([...stagedPaths, ...unstagedPaths, ...untrackedPaths])].sort(),
    stagedStat: compact(runGit(workspaceRoot, ["diff", "--cached", "--stat", "--compact-summary", "--no-ext-diff"], options.timeoutMs)),
    unstagedStat: compact(runGit(workspaceRoot, ["diff", "--stat", "--compact-summary", "--no-ext-diff"], options.timeoutMs)),
  };
}

export function readRepositoryState(workspaceRoot: string, options: GitStateOptions = {}): RepositoryState | null {
  const state = readGitDiffState(workspaceRoot, options);
  if (!state) return null;
  return {
    ...state,
    branch: compact(runGit(workspaceRoot, ["branch", "--show-current"], options.timeoutMs)),
    conflicts: readPaths(workspaceRoot, ["diff", "--name-only", "--diff-filter=U"], options) ?? [],
  };
}

export function detectWorkspaceRoot(cwd: string): string {
  return compact(runGit(cwd, ["rev-parse", "--show-toplevel"], 1_000)) ?? cwd;
}

export function detectRepoId(cwd: string): string | undefined {
  const root = detectWorkspaceRoot(cwd);
  const origin = compact(runGit(root, ["config", "--get", "remote.origin.url"], 1_000));
  if (origin) {
    return origin.replace(/^https?:\/\//, "").replace(/^git@([^:]+):/, "$1/").replace(/\.git$/, "").replace(/\/$/, "").toLowerCase();
  }
  const normalizedRoot = process.platform === "win32" ? resolve(root).toLowerCase() : resolve(root);
  return `local:${createHash("sha256").update(normalizedRoot).digest("hex").slice(0, 24)}`;
}

function readPaths(workspaceRoot: string, args: string[], options: GitStateOptions): string[] | null {
  const output = runGit(workspaceRoot, args, options.timeoutMs);
  if (output === null) return null;
  return output.split("\0")
    .filter(Boolean)
    .map((path) => normalizeRepositoryPath(workspaceRoot, path))
    .filter((path): path is string => path !== null);
}

function normalizeRepositoryPath(workspaceRoot: string, path: string): string | null {
  if (isAbsolute(path)) return null;
  const root = resolve(workspaceRoot);
  const absolute = resolve(root, path);
  const repositoryPath = relative(root, absolute);
  if (!repositoryPath || repositoryPath === ".." || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) return null;
  return repositoryPath.split(sep).join("/");
}

function runGit(workspaceRoot: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): string | null {
  try {
    return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function compact(value: string | null): string | null {
  const text = value?.replace(/\s+$/g, "").trim() ?? "";
  return text ? text.slice(0, 2_000) : null;
}
