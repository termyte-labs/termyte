import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readGitDiffState, readGitHead } from "../src/capture/git-state.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("compact Git state", () => {
  it("captures HEAD plus staged and unstaged paths without patch content", () => {
    const root = repository();
    writeFileSync(join(root, "tracked.txt"), "changed secret payload\n");
    writeFileSync(join(root, "staged.txt"), "staged secret payload\n");
    git(root, "add", "staged.txt");

    const state = readGitDiffState(root)!;

    expect(state.head).toBe(readGitHead(root));
    expect(state.changedPaths).toEqual(["staged.txt", "tracked.txt"]);
    expect(state.stagedPaths).toEqual(["staged.txt"]);
    expect(state.unstagedPaths).toEqual(["tracked.txt"]);
    expect(JSON.stringify(state)).not.toContain("secret payload");
  });

  it("fails soft outside Git and when the execution budget is invalid", () => {
    const root = mkdtempSync(join(tmpdir(), "termyte-not-git-"));
    roots.push(root);
    expect(readGitHead(root)).toBeNull();
    expect(readGitHead(root, { timeoutMs: 0 })).toBeNull();
    expect(readGitDiffState(root)).toBeNull();
  });
});

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "termyte-git-state-"));
  roots.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "tracked.txt"), "initial\n");
  git(root, "add", "tracked.txt");
  git(root, "-c", "user.name=Termyte Test", "-c", "user.email=test@termyte.invalid", "commit", "-qm", "initial");
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore", windowsHide: true });
}