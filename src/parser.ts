import { redactCommand } from "./redact.js";
import type { ParsedAction, ShellFlavor } from "./types.js";

const POWER_SHELL_VERBS = new Set(["remove-item", "get-childitem", "get-content", "set-location", "copy-item", "move-item", "set-content", "add-content", "out-file", "new-item"]);

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

    if (char === "\\" && next && /["'\\\s]/.test(next)) {
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

function isDeleteFlagToken(token: string, command: string): boolean {
  if (token.startsWith("-")) {
    return true;
  }
  if (command === "del") {
    return token.toLowerCase() === "/s" || token.toLowerCase() === "/q";
  }
  return false;
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

function semanticAction(command: string, tokens: string[], lowered: string[]): {
  kind: ParsedAction["kind"];
  semanticId: string;
  domain: string;
  operation: string;
  target: string;
  confidence: number;
} | undefined {
  const text = command.toLowerCase();
  const first = lowered[0] ?? "";
  const second = lowered[1] ?? "";

  if (
    first === "set-content" ||
    first === "add-content" ||
    first === "out-file" ||
    first === "new-item" ||
    first === "copy-item" ||
    first === "move-item" ||
    first === "cp" ||
    first === "mv" ||
    />{1,2}/.test(command)
  ) {
    const redirectIndex = tokens.findIndex((token) => token.includes(">"));
    const target = first === "set-content" || first === "add-content" || first === "out-file" || first === "new-item"
      ? tokens.find((token, index) => index > 0 && !token.startsWith("-")) ?? "workspace"
      : redirectIndex >= 0
        ? tokens[redirectIndex + 1] ?? tokens.at(-1) ?? "workspace"
        : tokens.at(-1) ?? "workspace";
    return { kind: "filesystem.write", semanticId: "filesystem.write", domain: "filesystem", operation: "write", target, confidence: 0.82 };
  }

  if (first === "git") {
    if (second === "reset" && lowered.includes("--hard")) {
      return { kind: "git.destructive", semanticId: "git.reset.hard", domain: "git", operation: "reset hard", target: tokens.at(-1) ?? "HEAD", confidence: 0.97 };
    }
    if (second === "clean" && lowered.some((token) => token.startsWith("-") && token.includes("f"))) {
      return { kind: "git.destructive", semanticId: "git.clean.force", domain: "git", operation: "clean", target: "workspace", confidence: 0.97 };
    }
    if (second === "checkout" && hasFlag(tokens, ["-f", "--force"])) {
      return { kind: "git.destructive", semanticId: "git.checkout.force", domain: "git", operation: "checkout force", target: tokens.at(-1) ?? "workspace", confidence: 0.95 };
    }
    if (second === "branch" && tokens.some((token) => token === "-D")) {
      return { kind: "git.destructive", semanticId: "git.branch.delete.force", domain: "git", operation: "delete branch", target: tokens.at(-1) ?? "branch", confidence: 0.95 };
    }
    if (second === "tag" && hasFlag(tokens, ["-d", "--delete"])) {
      return { kind: "git.destructive", semanticId: "git.tag.delete", domain: "git", operation: "delete tag", target: tokens.at(-1) ?? "tag", confidence: 0.93 };
    }
    if (second === "stash" && lowered[2] === "drop") {
      return { kind: "git.destructive", semanticId: "git.stash.drop", domain: "git", operation: "drop stash", target: tokens.at(-1) ?? "stash", confidence: 0.93 };
    }
    if (second === "rebase" && hasFlag(tokens, ["-i", "--interactive"])) {
      return { kind: "git.destructive", semanticId: "git.rebase.interactive", domain: "git", operation: "interactive rebase", target: tokens.at(-1) ?? "HEAD", confidence: 0.9 };
    }
    if (second === "reflog" && lowered[2] === "expire") {
      return { kind: "git.destructive", semanticId: "git.reflog.expire", domain: "git", operation: "expire reflog", target: "reflog", confidence: 0.93 };
    }
  }

  if (
    /\b(curl|wget|irm|invoke-webrequest)\b[\s\S]*(\||\$\(|<\(|iex|invoke-expression|\bexec\b|\bsh\b|\bbash\b)/i.test(command) ||
    (/\bhttps?:\/\//i.test(command) && ["node", "python", "powershell", "pwsh", "iex", "bash", "sh"].includes(first))
  ) {
    return { kind: "remote-script.execution", semanticId: "remote-script.execute", domain: "network", operation: "execute remote script", target: "remote script", confidence: 0.9 };
  }

  if (
    first === "sudo" ||
    first === "doas" ||
    first === "pkexec" ||
    (first === "su" && lowered.includes("-c")) ||
    first === "runas" ||
    (first === "start-process" && text.includes("-verb runas"))
  ) {
    return { kind: "privilege.escalation", semanticId: "privilege.escalation", domain: "system", operation: "elevate privileges", target: first, confidence: 0.9 };
  }

  if (first === "chmod" && hasFlag(tokens, ["-r", "--recursive"]) && lowered.includes("777")) {
    return { kind: "privilege.escalation", semanticId: "permission.chmod_recursive_777", domain: "filesystem", operation: "chmod recursive 777", target: tokens.at(-1) ?? "workspace", confidence: 0.96 };
  }

  if (
    /(api[_-]?key|secret|token|password|passwd|authorization|credentials|id_rsa|\.aws[\\/]+credentials|\.env)/i.test(command) &&
    /^(cat|type|get-content|printenv|echo|node|python|powershell|pwsh|rg|grep)$/i.test(first)
  ) {
    return { kind: "secret.access", semanticId: "secret.access", domain: "secrets", operation: "read secret", target: tokens.at(-1) ?? "secret", confidence: 0.86 };
  }

  if (first === "docker") {
    if (second === "build") {
      return { kind: "docker.destructive", semanticId: "docker.build", domain: "docker", operation: "build image", target: tokens.at(-1) ?? "docker build", confidence: 0.88 };
    }
    if (second === "system" && lowered[2] === "prune") {
      return { kind: "docker.destructive", semanticId: "docker.system.prune", domain: "docker", operation: "system prune", target: "docker system", confidence: 0.94 };
    }
    if ((second === "volume" && ["rm", "prune"].includes(lowered[2] ?? "")) || (second === "rm" && hasFlag(tokens, ["-f", "--force"]))) {
      return { kind: "docker.destructive", semanticId: "docker.destructive", domain: "docker", operation: "delete docker resource", target: tokens.at(-1) ?? "docker", confidence: 0.92 };
    }
  }

  if (
    (first === "prisma" && second === "migrate") ||
    (first === "alembic" && second === "upgrade") ||
    (first === "kubectl" && ["apply", "delete", "rollout"].includes(second)) ||
    (first === "terraform" && ["apply", "destroy"].includes(second)) ||
    (first === "vercel" && lowered.includes("--prod")) ||
    (first === "firebase" && second === "deploy") ||
    (first === "aws" && lowered.some((token) => ["deploy", "delete-stack", "update-stack"].includes(token)))
  ) {
    return { kind: "deploy.mutation", semanticId: "deploy.mutation", domain: "deploy", operation: "mutate deployment", target: first, confidence: 0.88 };
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

  if (
    packageManager &&
    (
      (packageManager === "npm" && (lowered[1] === "install" || lowered[1] === "i" || lowered[1] === "add")) ||
      (packageManager === "pnpm" && (lowered[1] === "install" || lowered[1] === "i" || lowered[1] === "add")) ||
      (packageManager === "yarn" && (lowered[1] === "add" || lowered[1] === "install"))
    )
  ) {
    const packageTargets = tokens.slice(2).filter((token) => !token.startsWith("-"));
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: "package.install",
      semanticId: `package.${packageManager}.install`,
      domain: "package",
      operation: "install",
      target: packageTargets.join(" ") || packageManager,
      flags: tokens.filter((token) => token.startsWith("-")),
      isWildcard: false,
      isRecursive: false,
      isForce: false,
      packageManager,
      confidence: 0.92,
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

  const semantic = semanticAction(command, tokens, lowered);
  if (semantic) {
    return {
      rawCommand: command,
      redactedCommand,
      tokens,
      shell,
      kind: semantic.kind,
      semanticId: semantic.semanticId,
      domain: semantic.domain,
      operation: semantic.operation,
      target: semantic.target,
      flags: tokens.filter((token) => token.startsWith("-")),
      isWildcard: tokens.some((token) => containsWildcard(token)),
      isRecursive: false,
      isForce: hasFlag(tokens, ["-f", "--force", "-D", "--hard"]),
      confidence: semantic.confidence,
    };
  }

  if (lowered[0] === "rm" || lowered[0] === "remove-item" || lowered[0] === "del") {
    const recursive = hasFlag(tokens, ["-r", "-rf", "-fr", "-recurse", "--recursive", "/s"]);
    const force = hasFlag(tokens, ["-f", "--force", "-force", "/q"]);
    const targets = tokens.filter((token, index) => {
      if (index === 0) return false;
      if (isDeleteFlagToken(token, lowered[0])) return false;
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
