import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { readRepositoryState } from "../experience/git-state.js";

export type FreshnessState = "current" | "changed" | "stale" | "unverifiable";
export interface FreshnessResult { state: FreshnessState; reasons: string[]; }

export function checkFreshness(workspaceRoot: string | null | undefined, files: string[]): FreshnessResult {
  if (!workspaceRoot || !existsSync(workspaceRoot)) return { state: "unverifiable", reasons: ["workspace_missing"] };
  const root = resolve(workspaceRoot);
  const normalized = files.filter(Boolean).map((file) => {
    const local = relative(root, resolve(root, file));
    return !local || local === ".." || local.startsWith("..\\") || local.startsWith("../") || isAbsolute(local)
      ? null : local.split("\\").join("/");
  });
  const missing = normalized.filter((file): file is string => Boolean(file)).filter((file) => !existsSync(resolve(root, file)));
  if (normalized.some((file) => file === null) || missing.length > 0) {
    return { state: "stale", reasons: [...(normalized.some((file) => file === null) ? ["path_outside_workspace"] : []), ...missing.map((file) => `missing:${file}`)] };
  }
  const repo = readRepositoryState(root);
  if (!repo) return { state: "unverifiable", reasons: ["git_unavailable"] };
  const changed = new Set(repo.changedPaths);
  const touched = normalized.filter((file): file is string => Boolean(file)).filter((file) => changed.has(file));
  return touched.length > 0 ? { state: "changed", reasons: touched.map((file) => `changed:${file}`) } : { state: "current", reasons: [] };
}
