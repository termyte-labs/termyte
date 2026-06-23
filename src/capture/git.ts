import { execSync } from "node:child_process";

export interface GitDiffResult {
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
  }>;
  diff: string;
  commitHash: string;
  branch: string;
}

export function captureGitDiff(workspaceRoot: string): GitDiffResult | null {
  try {
    const branch = execSync("git branch --show-current", { cwd: workspaceRoot, encoding: "utf-8" }).trim();
    const commitHash = execSync("git rev-parse HEAD", { cwd: workspaceRoot, encoding: "utf-8" }).trim();

    const diffStat = execSync("git diff --numstat", { cwd: workspaceRoot, encoding: "utf-8" }).trim();
    const files = diffStat.split("\n").filter(Boolean).map((line) => {
      const [additions, deletions, path] = line.split("\t");
      return {
        path,
        status: "modified",
        additions: parseInt(additions) || 0,
        deletions: parseInt(deletions) || 0,
      };
    });

    const diff = execSync("git diff --no-color", { cwd: workspaceRoot, encoding: "utf-8", maxBuffer: 1024 * 1024 });

    return { files, diff, commitHash, branch };
  } catch {
    return null;
  }
}

export function captureGitLog(workspaceRoot: string, count = 10): Array<{ hash: string; message: string; date: string }> {
  try {
    const log = execSync(`git log --oneline -${count} --format="%H|%s|%ai"`, {
      cwd: workspaceRoot,
      encoding: "utf-8",
    }).trim();
    return log.split("\n").filter(Boolean).map((line) => {
      const [hash, message, date] = line.split("|");
      return { hash, message, date };
    });
  } catch {
    return [];
  }
}

export function captureGitStatus(workspaceRoot: string): string {
  try {
    return execSync("git status --short", { cwd: workspaceRoot, encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}
