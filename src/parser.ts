import { redactCommand } from "./redact.js";
import type { ParsedAction, ShellFlavor } from "./types.js";

const POWER_SHELL_VERBS = new Set(["remove-item", "get-childitem", "set-location", "copy-item", "move-item"]);

function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (quote) {
      if (char === "\\" && quote === '"' && next) {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    if (char === "\\" && next) {
      current += next;
      index += 1;
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function guessShell(tokens: string[]): ShellFlavor {
  const first = tokens[0]?.toLowerCase() ?? "";
  if (POWER_SHELL_VERBS.has(first)) {
    return "powershell";
  }
  if (first === "powershell" || first === "pwsh") {
    return "powershell";
  }
  if (first === "cmd" || first === "cmd.exe") {
    return "cmd";
  }
  return "sh";
}

function hasFlag(tokens: string[], names: string[]): boolean {
  const lowered = tokens.map((token) => token.toLowerCase());
  return lowered.some((token) => {
    if (names.includes(token)) {
      return true;
    }

    if (token.startsWith("-") && !token.startsWith("--")) {
      const chars = token.slice(1);
      return names.some((name) => name.startsWith("-") && name.length === 2 && chars.includes(name.slice(1)));
    }

    if (token.startsWith("/")) {
      return names.includes(token);
    }

    return false;
  });
}

function containsWildcard(target: string): boolean {
  return /[*?\[]/.test(target);
}

function detectSqlPattern(command: string): ParsedAction["sqlPattern"] | undefined {
  if (/\bdrop\s+table\b/i.test(command)) {
    return "drop-table";
  }
  if (/\btruncate\s+table\b/i.test(command)) {
    return "truncate-table";
  }
  if (/\bdelete\s+from\b/i.test(command)) {
    return /\bdelete\s+from\b[\s\S]*?\bwhere\b/i.test(command) ? "delete-with-where" : "delete-without-where";
  }
  return undefined;
}

function detectPackageManager(tokens: string[]): ParsedAction["packageManager"] | undefined {
  const first = tokens[0]?.toLowerCase() ?? "";
  if (first === "npm" || first === "pnpm" || first === "yarn") {
    return first;
  }
  return undefined;
}

function extractGitBranch(tokens: string[]): string | undefined {
  const pushIndex = tokens.findIndex((token) => token.toLowerCase() === "push");
  if (pushIndex === -1) return undefined;
  const remoteIndex = tokens.findIndex((token, index) => index > pushIndex && !token.startsWith("-"));
  const branchIndex = tokens.findIndex((token, index) => index > remoteIndex && !token.startsWith("-"));
  return tokens[branchIndex];
}

export function parseAction(command: string): ParsedAction {
  const tokens = tokenize(command);
  const shell = guessShell(tokens);
  const redactedCommand = redactCommand(command);
  const lowered = tokens.map((token) => token.toLowerCase());
  const sqlPattern = detectSqlPattern(command);
  const packageManager = detectPackageManager(tokens);

  if (sqlPattern) {
    const operation = sqlPattern === "drop-table" ? "drop table" : sqlPattern === "truncate-table" ? "truncate table" : "delete from";
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: "sql.destructive",
      semanticId: `sql.${sqlPattern}`,
      domain: "sql",
      operation,
      target: "database",
      flags: [],
      isWildcard: false,
      isRecursive: false,
      isForce: false,
      sqlPattern,
      confidence: 0.97,
    };
  }

  if (packageManager && lowered.includes("publish")) {
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: "package.publish",
      semanticId: `package.${packageManager}.publish`,
      domain: "package",
      operation: "publish",
      target: packageManager,
      flags: tokens.filter((token) => token.startsWith("-")),
      isWildcard: false,
      isRecursive: false,
      isForce: false,
      packageManager,
      confidence: 0.96,
    };
  }

  if (lowered[0] === "git" && lowered[1] === "push") {
    const force = hasFlag(tokens, ["--force", "-f", "--force-with-lease"]);
    const branch = extractGitBranch(tokens);
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: "git.push",
      semanticId: force ? "git.push.force" : "git.push",
      domain: "git",
      operation: "push",
      target: branch ?? "remote",
      flags: tokens.filter((token) => token.startsWith("-")),
      isWildcard: false,
      isRecursive: false,
      isForce: force,
      gitBranch: branch,
      confidence: force ? 0.98 : 0.95,
    };
  }

  if (lowered[0] === "rm" || lowered[0] === "remove-item" || lowered[0] === "del") {
    const recursive = hasFlag(tokens, ["-r", "-rf", "-fr", "-recurse", "--recursive", "/s"]);
    const force = hasFlag(tokens, ["-f", "--force", "-force", "/q"]);
    const targets = tokens.filter((token, index) => {
      if (index === 0) return false;
      if (token.startsWith("-") || token.startsWith("/")) return false;
      return true;
    });
    const primaryTarget = targets[0] ?? "*";
    const wildcard = targets.some((target) => containsWildcard(target));
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: "filesystem.delete",
      semanticId: recursive && force && wildcard
        ? "filesystem.delete.recursive.force.wildcard"
        : recursive && force
          ? "filesystem.delete.recursive.force"
          : wildcard
            ? "filesystem.delete.wildcard"
            : "filesystem.delete.file",
      domain: "filesystem",
      operation: "delete",
      target: primaryTarget,
      flags: tokens.filter((token) => token.startsWith("-") || token.startsWith("/")),
      isWildcard: wildcard,
      isRecursive: recursive,
      isForce: force,
      confidence: 0.98,
    };
  }

  return {
    rawCommand: command,
    redactedCommand,
    tokens,
    shell,
    kind: "shell.generic",
    semanticId: "shell.generic",
    domain: "shell",
    operation: "run",
    target: tokens[0] ?? "unknown",
    flags: tokens.filter((token) => token.startsWith("-")),
    isWildcard: tokens.some((token) => containsWildcard(token)),
    isRecursive: false,
    isForce: false,
    confidence: 0.5,
  };
}
