import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";
import type { ParsedAction, ResolvedTargets, TargetClassification } from "./types.js";

function isInsideWorkspace(workspaceRoot: string, targetPath: string): boolean {
  const relative = path.relative(workspaceRoot, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isFilesystemRoot(target: string): boolean {
  const normalized = path.normalize(target);
  if (process.platform === "win32") {
    return /^[A-Za-z]:\\?$/.test(normalized);
  }
  return normalized === path.parse(normalized).root;
}

function normalizedSegments(target: string): string[] {
  return target
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);
}

function classifyTarget(rawTarget: string, resolvedTarget: string, workspaceRoot: string): TargetClassification {
  const base = path.basename(resolvedTarget || rawTarget);
  const normalizedRaw = rawTarget.replace(/\\/g, "/");
  const homeDir = os.homedir().replace(/\\/g, "/");
  const workspaceBase = path.basename(workspaceRoot).toLowerCase();
  const lowerBase = base.toLowerCase();
  const resolvedSegments = normalizedSegments(resolvedTarget);
  const rawSegments = normalizedSegments(rawTarget);
  const allSegments = new Set([...resolvedSegments, ...rawSegments]);

  if (rawTarget === "/" || isFilesystemRoot(rawTarget) || isFilesystemRoot(resolvedTarget)) {
    return {
      target: resolvedTarget,
      category: "filesystem-root",
      sensitive: true,
      reason: "root path would affect the whole filesystem",
    };
  }

  const normalizedResolved = resolvedTarget.replace(/\\/g, "/");
  if (
    normalizedRaw === "~" ||
    normalizedRaw.startsWith("~/") ||
    (path.isAbsolute(rawTarget) && (normalizedResolved === homeDir || normalizedResolved.startsWith(`${homeDir}/`)))
  ) {
    return {
      target: resolvedTarget,
      category: "home",
      sensitive: true,
      reason: "home directory targets are high impact and often irreversible",
    };
  }

  if (allSegments.has(".git") || allSegments.has(".github")) {
    return {
      target: resolvedTarget,
      category: "git-metadata",
      sensitive: true,
      reason: "repository metadata directories hold history, hooks, and workflow configuration",
    };
  }

  if (
    lowerBase === "package.json" ||
    lowerBase === "package-lock.json" ||
    lowerBase === "pnpm-lock.yaml" ||
    lowerBase === "yarn.lock" ||
    lowerBase === ".npmrc" ||
    lowerBase === "tsconfig.json" ||
    lowerBase.startsWith("vite.config.") ||
    lowerBase.startsWith(".env")
  ) {
    return {
      target: resolvedTarget,
      category: "config",
      sensitive: true,
      reason: `${base} is a configuration or environment file`,
    };
  }

  if (allSegments.has("node_modules")) {
    return {
      target: resolvedTarget,
      category: "dependency-tree",
      sensitive: true,
      reason: "dependency tree deletions are broad and expensive to recover",
    };
  }

  if (allSegments.has("dist") || allSegments.has("build")) {
    return {
      target: resolvedTarget,
      category: "build-output",
      sensitive: true,
      reason: "build output is often generated and can be recreated, but the blast radius is still broad",
    };
  }

  if (allSegments.has("src") || allSegments.has("app") || allSegments.has("lib")) {
    return {
      target: resolvedTarget,
      category: "workspace-source",
      sensitive: true,
      reason: `${base} is a source directory and is likely to contain core code`,
    };
  }

  if (lowerBase === workspaceBase) {
    return {
      target: resolvedTarget,
      category: "workspace-root",
      sensitive: true,
      reason: "workspace root operations can touch the entire repository",
    };
  }

  return {
    target: resolvedTarget,
    category: "normal",
    sensitive: false,
    reason: "no special sensitivity detected",
  };
}

function collectProtectedTargets(targetClasses: TargetClassification[]): string[] {
  return targetClasses
    .filter((entry) => entry.category === "git-metadata" || entry.category === "home" || entry.category === "filesystem-root")
    .map((entry) => entry.target);
}

function recoverabilityFor(classes: TargetClassification[], insideWorkspace: boolean, targetCount: number): "high" | "medium" | "low" {
  if (!insideWorkspace) return "low";
  if (classes.some((entry) => entry.category === "filesystem-root" || entry.category === "home" || entry.category === "git-metadata")) {
    return "low";
  }
  if (targetCount > 3 || classes.some((entry) => entry.category === "workspace-source" || entry.category === "dependency-tree")) {
    return "medium";
  }
  if (classes.some((entry) => entry.category === "build-output")) {
    return "medium";
  }
  return "high";
}

export function resolveTargets(action: ParsedAction, workspaceRoot: string): ResolvedTargets {
  if (action.kind === "git.push") {
    return {
      targetKind: "git",
      workspaceRoot,
      insideWorkspace: true,
      targetCount: 1,
      expandedTargets: action.gitBranch ? [action.gitBranch] : ["remote"],
      protectedTargets: [],
      protectedBranch: ["main", "master", "trunk"].includes((action.gitBranch ?? "").toLowerCase()),
      sensitiveTargets: [],
      targetClasses: [],
      recoverability: "low",
      outsideWorkspace: false,
    };
  }

  if (action.kind === "package.publish") {
    return {
      targetKind: "package",
      workspaceRoot,
      insideWorkspace: true,
      targetCount: 1,
      expandedTargets: [action.packageManager ?? "package"],
      protectedTargets: [],
      sensitiveTargets: [],
      targetClasses: [],
      recoverability: "medium",
      outsideWorkspace: false,
    };
  }

  if (action.kind === "sql.destructive") {
    return {
      targetKind: "sql",
      workspaceRoot,
      insideWorkspace: true,
      targetCount: 1,
      expandedTargets: [action.sqlPattern ?? "sql"],
      protectedTargets: [],
      sensitiveTargets: [],
      targetClasses: [],
      recoverability: "low",
      outsideWorkspace: false,
    };
  }

  if (action.kind !== "filesystem.delete") {
    return {
      targetKind: "unknown",
      workspaceRoot,
      insideWorkspace: true,
      targetCount: 0,
      expandedTargets: [],
      protectedTargets: [],
      sensitiveTargets: [],
      targetClasses: [],
      recoverability: "high",
      outsideWorkspace: false,
    };
  }

  const rawTargets = action.tokens.filter((token, index) => index > 0 && !token.startsWith("-") && !token.startsWith("/"));
  const patterns = rawTargets.length > 0 ? rawTargets : [action.target];
  const expandedTargets = new Set<string>();

  for (const pattern of patterns) {
    if (pattern.includes("*") || pattern.includes("?") || pattern.includes("[")) {
      const matches = fg.sync(pattern, {
        cwd: workspaceRoot,
        dot: true,
        onlyFiles: false,
        markDirectories: true,
        unique: true,
        followSymbolicLinks: false,
      });
      for (const match of matches.slice(0, 100)) {
        expandedTargets.add(path.resolve(workspaceRoot, match));
      }
      continue;
    }

    expandedTargets.add(path.resolve(workspaceRoot, pattern));
  }

  const resolved = [...expandedTargets];
  const insideWorkspace = resolved.every((targetPath) => isInsideWorkspace(workspaceRoot, targetPath));
  const targetClasses = resolved.map((resolvedTarget, index) => classifyTarget(patterns[Math.min(index, patterns.length - 1)] ?? resolvedTarget, resolvedTarget, workspaceRoot));
  const protectedTargets = collectProtectedTargets(targetClasses);
  const sensitiveTargets = targetClasses.filter((entry) => entry.sensitive).map((entry) => entry.target);

  return {
    targetKind: "filesystem",
    workspaceRoot,
    insideWorkspace,
    targetCount: resolved.length,
    expandedTargets: resolved,
    protectedTargets,
    sensitiveTargets,
    targetClasses,
    recoverability: recoverabilityFor(targetClasses, insideWorkspace, resolved.length),
    outsideWorkspace: !insideWorkspace,
  };
}

export function describeTargets(resolved: ResolvedTargets): string {
  if (resolved.targetCount === 0) {
    return "no targets";
  }

  if (resolved.targetCount <= 3) {
    return resolved.expandedTargets.join(", ");
  }

  return `${resolved.expandedTargets.slice(0, 3).join(", ")} (+${resolved.targetCount - 3} more)`;
}
