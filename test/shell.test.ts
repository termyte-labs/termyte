import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  buildGuardCommand,
  buildBashHookScript,
  buildPowerShellHookScript,
  buildSessionEnv,
  buildUnixShimScript,
  buildWindowsShimScript,
  buildZshHookScript,
  createGovernedSession,
  handleGuardFinalizeRequest,
  handleGuardHeartbeatRequest,
  handleGuardHookRequest,
  handleGuardRequest,
  interceptHook,
  recoverStaleShimExecutions,
  resolveRealExecutable,
  resolveSessionLaunchCommand,
  runResolvedExecutable,
  shellLaunchArgs,
  startGuardDaemon,
  verifyShimManifest,
} from "../src/shell.js";
import { openDatabase } from "../src/db.js";
import { Ledger } from "../src/ledger.js";
import { formatLedger, formatReplay, replayEntries } from "../src/format.js";

async function request(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";

    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      } finally {
        socket.end();
      }
    });
    socket.on("error", reject);
  });
}

function agePendingRecord(dbPath: string, ledgerId: number, startedAt: string, heartbeatAt: string | null = startedAt): void {
  const ctx = openDatabase(dbPath);
  const record = new Ledger(ctx.db).getById(ledgerId);
  const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;
  const nextMetadata = { ...metadata, startedAt, lastHeartbeatAt: heartbeatAt };
  if (heartbeatAt === null) {
    delete nextMetadata.lastHeartbeatAt;
  }
  ctx.db
    .prepare("UPDATE ledger SET created_at = ?, metadata_json = ? WHERE id = ?")
    .run(startedAt, JSON.stringify(nextMetadata), ledgerId);
}

function updatePendingMetadata(dbPath: string, ledgerId: number, values: Record<string, unknown>): void {
  const ctx = openDatabase(dbPath);
  const record = new Ledger(ctx.db).getById(ledgerId);
  const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;
  ctx.db
    .prepare("UPDATE ledger SET metadata_json = ? WHERE id = ?")
    .run(JSON.stringify({ ...metadata, ...values }), ledgerId);
}

function testShimPath(shimDir: string, tool: string): string {
  return process.platform === "win32" ? path.join(shimDir, `${tool}.cmd`) : path.join(shimDir, tool);
}

describe("governed shell runtime", () => {
  it("builds a governed session environment with shimmed PATH", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const env = buildSessionEnv(session);

    expect(env.TERMYTE_SESSION_ID).toBe(session.sessionId);
    expect(env.TERMYTE_GUARD_SOCKET).toBe(session.socketPath);
    expect(env.TERMYTE_SHIM_DIR).toBe(session.shimDir);
    expect(env.TERMYTE_DB_PATH).toBe(session.dbPath);
    expect(env.TERMYTE_WORKSPACE_ROOT).toBe(session.workspaceRoot);
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path");
    expect(pathKey).toBeDefined();
    expect(env[pathKey ?? "PATH"]?.startsWith(session.shimDir)).toBe(true);
  });

  it("does not emit duplicate PATH/Path keys in governed environments", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-path-"));
    const session = createGovernedSession(workspaceRoot);
    const env = buildSessionEnv(session);
    const pathKeys = Object.keys(env).filter((key) => key.toLowerCase() === "path");

    expect(pathKeys).toHaveLength(1);
    expect(env[pathKeys[0]]?.split(path.delimiter)[0]).toBe(session.shimDir);
  });

  it("generates a Unix shim that forwards through the CLI guard", () => {
    const script = buildUnixShimScript("git");

    expect(script).toContain('if [ -z "${TERMYTE_CLI_PATH:-}" ]');
    expect(script).toContain('exec "${TERMYTE_NODE:-node}" "${TERMYTE_CLI_PATH}" _shim "git" "$@"');
  });

  it("generates a Windows shim that forwards through the CLI guard", () => {
    const script = buildWindowsShimScript("git");

    expect(script).toContain('exit /b 126');
    expect(script).toContain('"%TERMYTE_NODE%" "%TERMYTE_CLI_PATH%" _shim git %*');
  });

  it("verifies untouched session shims against the generated manifest", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-manifest-"));
    const session = createGovernedSession(workspaceRoot);
    const result = verifyShimManifest(session, "git");
    const manifest = JSON.parse(fs.readFileSync(session.shimManifestPath, "utf8")) as { entries: Array<{ name: string; path: string; sha256: string; size: number; createdAt: string; platform: string }> };
    const git = manifest.entries.find((entry) => entry.name === "git");

    expect(result.ok).toBe(true);
    expect(git?.path).toBe(testShimPath(session.shimDir, "git"));
    expect(git?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(git?.size).toBeGreaterThan(0);
    expect(git?.createdAt).toBeTypeOf("string");
    expect(git?.platform).toBe(process.platform);
  });

  it("rejects modified shim content before execution", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-modified-"));
    const session = createGovernedSession(workspaceRoot);
    fs.appendFileSync(testShimPath(session.shimDir, "git"), "\nREM tampered\n", "utf8");

    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git --version",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["--version"],
    });
    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(response.decision).toBe("block");
    expect(response.reason).toContain("shim_tamper_detected");
    expect(record?.status).toBe("failed");
    expect(metadata.executionError).toBe("shim_tamper_detected");
    expect(String(metadata.tamperReasons)).toContain("git");
  });

  it("detects missing shim files", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-missing-"));
    const session = createGovernedSession(workspaceRoot);
    fs.rmSync(testShimPath(session.shimDir, "git"), { force: true });

    const result = verifyShimManifest(session, "git");

    expect(result.ok).toBe(false);
    expect(result.reasons.join("; ")).toContain("shim missing: git");
  });

  it("detects unexpected executable files in the shim directory", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-extra-"));
    const session = createGovernedSession(workspaceRoot);
    const extra = process.platform === "win32" ? path.join(session.shimDir, "evil.cmd") : path.join(session.shimDir, "evil");
    fs.writeFileSync(extra, "echo evil", "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(extra, 0o755);
    }

    const result = verifyShimManifest(session, "git");

    expect(result.ok).toBe(false);
    expect(result.reasons.join("; ")).toContain("unexpected executable in shim dir");
  });

  it("shows shim tamper events in logs and replay", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-tamper-format-"));
    const session = createGovernedSession(workspaceRoot);
    fs.appendFileSync(testShimPath(session.shimDir, "git"), "\nREM tampered\n", "utf8");

    handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git --version",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["--version"],
    });
    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const logs = formatLedger(ledger.listLatest());
    const replay = formatReplay(ledger.replay());

    expect(logs).toContain("shim_tamper_detected");
    expect(replay).toContain("shim_tamper_detected");
  });

  it("allows normal shim decisions when the manifest is intact", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shim-normal-"));
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git --version",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["--version"],
    });

    expect(response.decision).toBe("allow");
    expect(response.reason).not.toContain("shim_tamper_detected");
  });

  it("generates bash hook code that blocks failed guard decisions before dispatch", () => {
    const script = buildBashHookScript();

    expect(script).toContain("trap '__termyte_preexec' DEBUG");
    expect(script).toContain("_hook bash");
    expect(script).toContain("return 1");
    expect(script).toContain("TERMYTE_HOOK_ACTIVE");
  });

  it("generates zsh hook code that blocks failed guard decisions before dispatch", () => {
    const script = buildZshHookScript();

    expect(script).toContain("TRAPDEBUG()");
    expect(script).toContain("_hook zsh");
    expect(script).toContain("return 1");
    expect(script).toContain("TERMYTE_HOOK_ACTIVE");
  });

  it("generates PowerShell hook code that blocks failed guard decisions before dispatch", () => {
    const script = buildPowerShellHookScript();

    expect(script).toContain("Set-PSReadLineOption -CommandValidationHandler");
    expect(script).toContain("_hook powershell");
    expect(script).toContain("throw \"Termyte blocked shell command before dispatch.\"");
  });

  it("blocks guard requests from the wrong session id", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(session, {
      sessionId: "wrong-session",
      command: "echo hello",
      cwd: workspaceRoot,
    });

    expect(response.decision).toBe("block");
    expect(response.reason).toContain("Invalid or missing Termyte session");
  });

  it("fails closed on destructive guard requests before shim execution", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}", "utf8");
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "rm -rf *",
      cwd: workspaceRoot,
    });

    expect(response.decision).toBe("block");
    expect(response.semanticId).toBe("filesystem.delete.recursive.force.wildcard");
  });

  it("blocks destructive shell-hook lines and records them separately from shims", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-hook-block-"));
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}", "utf8");
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "rm -rf *",
      cwd: workspaceRoot,
    });
    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(response.decision).toBe("block");
    expect(record?.status).toBe("blocked");
    expect(record?.decision).toBe("block");
    expect(metadata.runtime).toBe("shell-hook");
    expect(metadata.hookRuntime).toBe(true);
    expect(metadata.shell).toBe("bash");
    expect(metadata.commandLine).toBe("rm -rf *");
    expect(metadata.sessionId).toBe(session.sessionId);
    expect(metadata.workspaceRoot).toBe(session.workspaceRoot);
  });

  it("records allowed shell-hook lines", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-hook-allow-"));
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "zsh",
      commandLine: "echo hello",
      cwd: workspaceRoot,
    });
    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(response.decision).toBe("allow");
    expect(record?.status).toBe("executed");
    expect(record?.exitCode).toBe(0);
    expect(metadata.runtime).toBe("shell-hook");
    expect(metadata.hookRuntime).toBe(true);
    expect(metadata.shell).toBe("zsh");
  });

  it("fails closed when shell hook cannot reach the guard daemon", async () => {
    const originalSessionId = process.env.TERMYTE_SESSION_ID;
    const originalSocket = process.env.TERMYTE_GUARD_SOCKET;
    process.env.TERMYTE_SESSION_ID = "missing-session";
    process.env.TERMYTE_GUARD_SOCKET = process.platform === "win32"
      ? "\\\\.\\pipe\\termyte-missing-session"
      : path.join(os.tmpdir(), "termyte-missing-session.sock");

    try {
      await expect(interceptHook("bash", "echo hello")).resolves.toBe(126);
    } finally {
      if (originalSessionId === undefined) {
        delete process.env.TERMYTE_SESSION_ID;
      } else {
        process.env.TERMYTE_SESSION_ID = originalSessionId;
      }
      if (originalSocket === undefined) {
        delete process.env.TERMYTE_GUARD_SOCKET;
      } else {
        process.env.TERMYTE_GUARD_SOCKET = originalSocket;
      }
    }
  });

  it("distinguishes shell-hook and shell-shim executions in logs and replay", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-hook-format-"));
    const session = createGovernedSession(workspaceRoot);
    handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "powershell",
      commandLine: "echo hello",
      cwd: workspaceRoot,
    });
    const pending = new Map();
    const shim = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "node -e \"process.exit(0)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(0)"],
    }, pending);
    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: shim.ledgerId,
      tool: "node",
      argv: ["-e", "process.exit(0)"],
      executablePath: process.execPath,
      outcome: {
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const logs = formatLedger(ledger.listLatest());
    const replay = formatReplay(ledger.replay());

    expect(logs).toContain("shell-hook");
    expect(logs).toContain("shell-shim");
    expect(replay).toContain("echo hello");
    expect(replay).toContain("node -e \"process.exit(0)\"");
  });

  it("correlates an allowed interactive command hook with its shim execution", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-correlation-"));
    const session = createGovernedSession(workspaceRoot);
    const correlationId = "corr-allowed-1";
    const hook = handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "git --version",
      cwd: workspaceRoot,
      commandCorrelationId: correlationId,
    });
    const pending = new Map();
    const shim = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git --version",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["--version"],
      commandCorrelationId: correlationId,
    }, pending);
    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: shim.ledgerId,
      tool: "git",
      argv: ["--version"],
      executablePath: process.execPath,
      commandCorrelationId: correlationId,
      outcome: {
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const hookRecord = ledger.getById(hook.ledgerId ?? 0);
    const shimRecord = ledger.getById(shim.ledgerId ?? 0);
    const hookMetadata = JSON.parse(hookRecord?.metadataJson ?? "{}") as Record<string, unknown>;
    const shimMetadata = JSON.parse(shimRecord?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(hookMetadata.runtime).toBe("shell-hook");
    expect(shimMetadata.runtime).toBe("shell-shim");
    expect(hookMetadata.commandCorrelationId).toBe(correlationId);
    expect(shimMetadata.commandCorrelationId).toBe(correlationId);
  });

  it("records blocked interactive commands only as shell-hook rows", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-correlation-block-"));
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}", "utf8");
    const session = createGovernedSession(workspaceRoot);
    const correlationId = "corr-blocked-1";
    handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "rm -rf *",
      cwd: workspaceRoot,
      commandCorrelationId: correlationId,
    });

    const records = new Ledger(openDatabase(session.dbPath).db).replay();
    const correlated = records.filter((record) => {
      const metadata = JSON.parse(record.metadataJson ?? "{}") as Record<string, unknown>;
      return metadata.commandCorrelationId === correlationId;
    });
    const runtimes = correlated.map((record) => (JSON.parse(record.metadataJson ?? "{}") as Record<string, unknown>).runtime);

    expect(correlated).toHaveLength(1);
    expect(runtimes).toEqual(["shell-hook"]);
    expect(correlated[0]?.decision).toBe("block");
  });

  it("assigns different correlation ids to separate interactive commands", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-correlation-separate-"));
    const session = createGovernedSession(workspaceRoot);
    const first = handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "echo one",
      cwd: workspaceRoot,
      commandCorrelationId: "corr-one",
    });
    const second = handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "echo two",
      cwd: workspaceRoot,
      commandCorrelationId: "corr-two",
    });
    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const firstMetadata = JSON.parse(ledger.getById(first.ledgerId ?? 0)?.metadataJson ?? "{}") as Record<string, unknown>;
    const secondMetadata = JSON.parse(ledger.getById(second.ledgerId ?? 0)?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(firstMetadata.commandCorrelationId).toBe("corr-one");
    expect(secondMetadata.commandCorrelationId).toBe("corr-two");
  });

  it("preserves correlation metadata across nested shim subprocesses", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-correlation-nested-"));
    const session = createGovernedSession(workspaceRoot);
    const correlationId = "corr-nested-1";
    const pending = new Map();
    const parent = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "npm run build",
      cwd: workspaceRoot,
      tool: "npm",
      argv: ["run", "build"],
      commandCorrelationId: correlationId,
    }, pending);
    const child = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git status",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["status"],
      commandCorrelationId: correlationId,
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const parentMetadata = JSON.parse(ledger.getById(parent.ledgerId ?? 0)?.metadataJson ?? "{}") as Record<string, unknown>;
    const childMetadata = JSON.parse(ledger.getById(child.ledgerId ?? 0)?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(parentMetadata.commandCorrelationId).toBe(correlationId);
    expect(childMetadata.commandCorrelationId).toBe(correlationId);
  });

  it("displays correlated hook and shim records clearly in logs and replay", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-correlation-format-"));
    const session = createGovernedSession(workspaceRoot);
    const correlationId = "corr-format-1";
    handleGuardHookRequest(session, {
      type: "hook",
      sessionId: session.sessionId,
      shell: "bash",
      commandLine: "git --version",
      cwd: workspaceRoot,
      commandCorrelationId: correlationId,
    });
    const pending = new Map();
    const shim = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git --version",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["--version"],
      commandCorrelationId: correlationId,
    }, pending);
    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: shim.ledgerId,
      tool: "git",
      argv: ["--version"],
      executablePath: process.execPath,
      commandCorrelationId: correlationId,
      outcome: {
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const logs = formatLedger(ledger.listLatest());
    const replay = formatReplay(ledger.replay());

    expect(logs).toContain("corr-format-");
    expect(replay).toContain("CORRELATED ACTION");
    expect(replay).toContain("shell-hook");
    expect(replay).toContain("shell-shim");
  });

  it("records blocked shim decisions as finalized ledger entries", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    fs.writeFileSync(path.join(workspaceRoot, "package.json"), "{}", "utf8");
    const session = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "git push --force origin main",
      cwd: workspaceRoot,
      tool: "git",
      argv: ["push", "--force", "origin", "main"],
    });
    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const record = ledger.getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(record?.decision).toBe("block");
    expect(record?.status).toBe("blocked");
    expect(record?.semanticId).toBe("git.push.force");
    expect(metadata.sessionId).toBe(session.sessionId);
    expect(metadata.shimRuntime).toBe(true);
  });

  it("records allowed shim executions after finalization", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const pending = new Map();
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "node -e \"console.log(1)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "console.log(1)"],
    }, pending);

    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: response.ledgerId,
      tool: "node",
      argv: ["-e", "console.log(1)"],
      executablePath: process.execPath,
      outcome: {
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 12,
      },
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const record = ledger.getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as { argv?: string[]; sessionId?: string; shimRuntime?: boolean; executablePath?: string };

    expect(record?.decision).toBe("allow");
    expect(record?.status).toBe("executed");
    expect(record?.exitCode).toBe(0);
    expect(metadata.argv).toEqual(["-e", "console.log(1)"]);
    expect(metadata.sessionId).toBe(session.sessionId);
    expect(metadata.shimRuntime).toBe(true);
    expect(metadata.executablePath).toBe(process.execPath);
  });

  it("records failed executable resolution as a finalized failed ledger entry", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const pending = new Map();
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "docker ps",
      cwd: workspaceRoot,
      tool: "docker",
      argv: ["ps"],
    }, pending);
    const message = "Termyte could not resolve the real executable for docker.";

    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: response.ledgerId,
      tool: "docker",
      argv: ["ps"],
      executablePath: null,
      errorMessage: message,
      outcome: {
        status: "failed",
        exitCode: 127,
        stdout: "",
        stderr: `${message}\n`,
        durationMs: 0,
        errorMessage: message,
      },
    }, pending);

    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as { executionError?: string; executablePath?: string | null };

    expect(record?.status).toBe("failed");
    expect(record?.exitCode).toBe(127);
    expect(metadata.executionError).toBe(message);
    expect(metadata.executablePath).toBeNull();
  });

  it("records child non-zero exit codes and exposes shimmed executions in replay data", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const pending = new Map();
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    }, pending);

    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: response.ledgerId,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
      executablePath: process.execPath,
      outcome: {
        status: "failed",
        exitCode: 7,
        stdout: "",
        stderr: "",
        durationMs: 5,
      },
    }, pending);

    const ledger = new Ledger(openDatabase(session.dbPath).db);
    const record = ledger.getById(response.ledgerId ?? 0);
    const replay = replayEntries(ledger.replay());
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as { argv?: string[]; runtime?: string; shimRuntime?: boolean };

    expect(record?.status).toBe("failed");
    expect(record?.exitCode).toBe(7);
    expect(metadata.argv).toEqual(["-e", "process.exit(7)"]);
    expect(metadata.runtime).toBe("shell-shim");
    expect(metadata.shimRuntime).toBe(true);
    expect(replay.at(-1)?.outcome).toBe("failed (exit 7)");
    expect(replay.at(-1)?.semanticMeaning).toBe("shell.generic");
  });

  it("recovers stale pending shell-shim entries after a simulated daemon crash", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-"));
    const crashedSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(crashedSession, {
      sessionId: crashedSession.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    });
    const oldStartedAt = new Date(Date.now() - 120_000).toISOString();
    agePendingRecord(crashedSession.dbPath, response.ledgerId ?? 0, oldStartedAt, null);

    const newSession = createGovernedSession(workspaceRoot);
    const recovered = recoverStaleShimExecutions(newSession, 60_000, new Date());
    const record = new Ledger(openDatabase(newSession.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(recovered).toBe(1);
    expect(record?.status).toBe("failed");
    expect(record?.stderr).toContain("guard_daemon_terminated_before_finalize");
    expect(metadata.sessionId).toBe(crashedSession.sessionId);
    expect(metadata.startedAt).toBe(oldStartedAt);
    expect(metadata.endedAt).toBeTypeOf("string");
    expect(metadata.durationMs).toBeTypeOf("number");
    expect(metadata.executionError).toBe("guard_daemon_terminated_before_finalize");
    expect(metadata.recovered).toBe(true);
  });

  it("does not recover active pending shell-shim entries before the stale timeout", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-active-"));
    const oldSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(oldSession, {
      sessionId: oldSession.sessionId,
      command: "node -e \"setTimeout(() => {}, 1000)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "setTimeout(() => {}, 1000)"],
    });
    const startedAt = new Date(Date.now() - 1_000).toISOString();
    agePendingRecord(oldSession.dbPath, response.ledgerId ?? 0, startedAt);

    const newSession = createGovernedSession(workspaceRoot);
    const recovered = recoverStaleShimExecutions(newSession, 60_000, new Date());
    const record = new Ledger(openDatabase(newSession.dbPath).db).getById(response.ledgerId ?? 0);

    expect(recovered).toBe(0);
    expect(record?.status).toBe("planned");
    expect(record?.decision).toBe("pending");
  });

  it("does not recover long-running shell-shim entries while the heartbeat is fresh", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-heartbeat-fresh-"));
    const oldSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(oldSession, {
      sessionId: oldSession.sessionId,
      command: "node -e \"setTimeout(() => {}, 65000)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "setTimeout(() => {}, 65000)"],
    });
    const startedAt = new Date(Date.now() - 120_000).toISOString();
    const freshHeartbeatAt = new Date(Date.now() - 2_000).toISOString();
    agePendingRecord(oldSession.dbPath, response.ledgerId ?? 0, startedAt);
    updatePendingMetadata(oldSession.dbPath, response.ledgerId ?? 0, {
      pid: 12345,
      lastHeartbeatAt: freshHeartbeatAt,
      heartbeatIntervalMs: 5_000,
    });

    const newSession = createGovernedSession(workspaceRoot);
    const recovered = recoverStaleShimExecutions(newSession, 60_000, new Date());
    const record = new Ledger(openDatabase(newSession.dbPath).db).getById(response.ledgerId ?? 0);

    expect(recovered).toBe(0);
    expect(record?.status).toBe("planned");
    expect(record?.decision).toBe("pending");
  });

  it("recovers shell-shim entries with stale heartbeat metadata as abandoned", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-heartbeat-stale-"));
    const oldSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(oldSession, {
      sessionId: oldSession.sessionId,
      command: "node -e \"setTimeout(() => {}, 65000)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "setTimeout(() => {}, 65000)"],
    });
    const startedAt = new Date(Date.now() - 180_000).toISOString();
    const staleHeartbeatAt = new Date(Date.now() - 120_000).toISOString();
    agePendingRecord(oldSession.dbPath, response.ledgerId ?? 0, startedAt);
    updatePendingMetadata(oldSession.dbPath, response.ledgerId ?? 0, {
      pid: 12345,
      lastHeartbeatAt: staleHeartbeatAt,
      heartbeatIntervalMs: 5_000,
    });

    const newSession = createGovernedSession(workspaceRoot);
    const recovered = recoverStaleShimExecutions(newSession, 60_000, new Date());
    const record = new Ledger(openDatabase(newSession.dbPath).db).getById(response.ledgerId ?? 0);
    const metadata = JSON.parse(record?.metadataJson ?? "{}") as Record<string, unknown>;

    expect(recovered).toBe(1);
    expect(record?.status).toBe("failed");
    expect(record?.stderr).toContain("shell_shim_heartbeat_stale_before_finalize");
    expect(metadata.lastHeartbeatAt).toBe(staleHeartbeatAt);
    expect(metadata.executionError).toBe("shell_shim_heartbeat_stale_before_finalize");
    expect(metadata.recovered).toBe(true);
  });

  it("ignores late heartbeat updates after a shell-shim command is finalized", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-heartbeat-finalized-"));
    const session = createGovernedSession(workspaceRoot);
    const pending = new Map();
    const response = handleGuardRequest(session, {
      sessionId: session.sessionId,
      command: "node -e \"process.exit(0)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(0)"],
    }, pending);

    handleGuardFinalizeRequest(session, {
      type: "finalize",
      sessionId: session.sessionId,
      ledgerId: response.ledgerId,
      tool: "node",
      argv: ["-e", "process.exit(0)"],
      executablePath: process.execPath,
      outcome: {
        status: "executed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      },
    }, pending);

    const heartbeat = handleGuardHeartbeatRequest(session, {
      type: "heartbeat",
      sessionId: session.sessionId,
      ledgerId: response.ledgerId,
      pid: 12345,
      lastHeartbeatAt: new Date().toISOString(),
      heartbeatIntervalMs: 5_000,
    });
    const record = new Ledger(openDatabase(session.dbPath).db).getById(response.ledgerId ?? 0);

    expect(heartbeat.decision).toBe("block");
    expect(record?.status).toBe("executed");
    expect(record?.decision).toBe("allow");
  });

  it("does not recover pending entries from unrelated workspaces or the active session", () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-a-"));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-b-"));
    const sessionA = createGovernedSession(workspaceA);
    const sessionB = createGovernedSession(workspaceB);
    const responseA = handleGuardRequest(sessionA, {
      sessionId: sessionA.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceA,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    });
    const responseB = handleGuardRequest(sessionB, {
      sessionId: sessionB.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceB,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    });
    const oldStartedAt = new Date(Date.now() - 120_000).toISOString();
    agePendingRecord(sessionA.dbPath, responseA.ledgerId ?? 0, oldStartedAt);
    agePendingRecord(sessionB.dbPath, responseB.ledgerId ?? 0, oldStartedAt);

    const recovered = recoverStaleShimExecutions(sessionA, 60_000, new Date());
    const recordA = new Ledger(openDatabase(sessionA.dbPath).db).getById(responseA.ledgerId ?? 0);
    const recordB = new Ledger(openDatabase(sessionB.dbPath).db).getById(responseB.ledgerId ?? 0);

    expect(recovered).toBe(0);
    expect(recordA?.status).toBe("planned");
    expect(recordB?.status).toBe("planned");
  });

  it("shows recovered shim entries in replay data", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-replay-"));
    const crashedSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(crashedSession, {
      sessionId: crashedSession.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    });
    agePendingRecord(crashedSession.dbPath, response.ledgerId ?? 0, new Date(Date.now() - 120_000).toISOString());

    const newSession = createGovernedSession(workspaceRoot);
    recoverStaleShimExecutions(newSession, 60_000, new Date());
    const ledger = new Ledger(openDatabase(newSession.dbPath).db);
    const replay = replayEntries(ledger.replay());

    expect(replay.at(-1)?.outcome).toBe("failed (recovered: shell_shim_heartbeat_stale_before_finalize)");
    expect(replay.at(-1)?.action).toBe("node -e \"process.exit(7)\"");
  });

  it("shows heartbeat recovery clearly in logs and replay text", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-recover-format-"));
    const crashedSession = createGovernedSession(workspaceRoot);
    const response = handleGuardRequest(crashedSession, {
      sessionId: crashedSession.sessionId,
      command: "node -e \"process.exit(7)\"",
      cwd: workspaceRoot,
      tool: "node",
      argv: ["-e", "process.exit(7)"],
    });
    agePendingRecord(crashedSession.dbPath, response.ledgerId ?? 0, new Date(Date.now() - 180_000).toISOString());
    updatePendingMetadata(crashedSession.dbPath, response.ledgerId ?? 0, {
      lastHeartbeatAt: new Date(Date.now() - 120_000).toISOString(),
      heartbeatIntervalMs: 5_000,
      pid: 12345,
    });

    const newSession = createGovernedSession(workspaceRoot);
    recoverStaleShimExecutions(newSession, 60_000, new Date());
    const ledger = new Ledger(openDatabase(newSession.dbPath).db);
    const logs = formatLedger(ledger.listLatest());
    const replay = formatReplay(ledger.replay());

    expect(logs).toContain("shell_shim_heartbeat_stale_before_finalize");
    expect(replay).toContain("failed (recovered: shell_shim_heartbeat_stale_before_finalize)");
  });

  it("quotes shim commands without merging whitespace-sensitive arguments", () => {
    const command = buildGuardCommand("git", ["commit", "-m", "hello world", "quote\"test"]);

    expect(command).toBe('git commit -m "hello world" "quote\\"test"');
  });

  it("resolves real executables from the original PATH without returning the shim", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const shimDir = path.join(workspaceRoot, "shim");
    const realDir = path.join(workspaceRoot, "real");
    fs.mkdirSync(shimDir);
    fs.mkdirSync(realDir);

    const executableName = process.platform === "win32" ? "git.cmd" : "git";
    const shimPath = path.join(shimDir, executableName);
    const realPath = path.join(realDir, executableName);
    fs.writeFileSync(shimPath, "shim", "utf8");
    fs.writeFileSync(realPath, "real", "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(shimPath, 0o755);
      fs.chmodSync(realPath, 0o755);
    }

    expect(resolveRealExecutable("git", [shimDir, realDir].join(path.delimiter), shimDir)).toBe(realPath);
  });

  it("resolves Windows npm-style global commands to .cmd launchers", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-win-launch-"));
    const session = createGovernedSession(workspaceRoot);
    const binDir = path.join(workspaceRoot, "npm-bin");
    fs.mkdirSync(binDir);
    const codexCmd = path.join(binDir, "codex.cmd");
    fs.writeFileSync(codexCmd, "@echo off\r\n", "utf8");

    const command = resolveSessionLaunchCommand("codex", { ...session, originalPath: [session.shimDir, binDir].join(path.delimiter) }, [], {
      platform: "win32",
      pathext: ".COM;.EXE;.BAT;.CMD",
    });

    expect(command).toBe(codexCmd);
  });

  it("resolves Windows npm-style global .cmd bins that are not Termyte shims", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-win-bin-"));
    const session = createGovernedSession(workspaceRoot);
    const binDir = path.join(workspaceRoot, "global-bin");
    fs.mkdirSync(binDir);
    const aiderCmd = path.join(binDir, "aider.cmd");
    fs.writeFileSync(aiderCmd, "@echo off\r\n", "utf8");

    const command = resolveSessionLaunchCommand("aider", { ...session, originalPath: binDir }, ["--version"], {
      platform: "win32",
      pathext: ".CMD;.EXE",
    });

    expect(command).toBe(aiderCmd);
  });

  it("preserves initial launch arguments exactly", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launch-args-"));
    const session = createGovernedSession(workspaceRoot);
    const args = ["--model", "gpt-5", "--prompt", "hello world"];

    expect(shellLaunchArgs("codex", args, session)).toEqual(args);
  });

  it("does not inject shell flags for Codex, Claude Code, or Aider", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launch-agent-"));
    const session = createGovernedSession(workspaceRoot);

    expect(shellLaunchArgs("codex", undefined, session)).toEqual([]);
    expect(shellLaunchArgs("claude", undefined, session)).toEqual([]);
    expect(shellLaunchArgs("aider", undefined, session)).toEqual([]);
  });

  it("preserves an explicitly requested non-shell launch with no args", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-launch-empty-"));
    const session = createGovernedSession(workspaceRoot);

    expect(shellLaunchArgs("codex", [], session)).toEqual([]);
  });

  it("resolves direct Windows .exe launch commands without rewriting them to shims", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-win-exe-"));
    const session = createGovernedSession(workspaceRoot);
    const binDir = path.join(workspaceRoot, "bin");
    fs.mkdirSync(binDir);
    const nodeExe = path.join(binDir, "node.exe");
    fs.writeFileSync(nodeExe, "binary", "utf8");

    const command = resolveSessionLaunchCommand("node.exe", { ...session, originalPath: [session.shimDir, binDir].join(path.delimiter) }, [], {
      platform: "win32",
      pathext: ".EXE;.CMD",
    });

    expect(command).toBe(nodeExe);
  });

  it("leaves non-shim Unix launch commands unchanged", () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-unix-launch-"));
    const session = createGovernedSession(workspaceRoot);

    expect(resolveSessionLaunchCommand("codex", session, [], { platform: "linux" })).toBe("codex");
  });

  it("documents Windows .cmd child_process semantics", () => {
    if (process.platform !== "win32") {
      return;
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-cmd-semantics-"));
    const wrapper = path.join(workspaceRoot, "npm.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\necho npm:%1\r\n", "utf8");

    const spawned = spawnSync(wrapper, ["publish"], { encoding: "utf8" });
    expect(spawned.error?.message).toContain("EINVAL");
    expect(() => execFileSync(wrapper, ["publish"], { encoding: "utf8" })).toThrow();
    expect(execSync(`"${wrapper}" publish`, { encoding: "utf8" }).trim()).toBe("npm:publish");
  });

  it("runs npm.cmd through Termyte's Windows command wrapper", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-npm-cmd-"));
    const wrapper = path.join(workspaceRoot, "npm.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nif \"%~1\"==\"publish\" exit /b 0\r\nexit /b 9\r\n", "utf8");

    const outcome = await runResolvedExecutable(wrapper, ["publish"], workspaceRoot, process.execPath);

    expect(outcome.status).toBe("executed");
    expect(outcome.exitCode).toBe(0);
  });

  it("runs npx.cmd through Termyte's Windows command wrapper", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-npx-cmd-"));
    const wrapper = path.join(workspaceRoot, "npx.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nif \"%~1\"==\"--version\" exit /b 0\r\nexit /b 9\r\n", "utf8");

    const outcome = await runResolvedExecutable(wrapper, ["--version"], workspaceRoot, process.execPath);

    expect(outcome.status).toBe("executed");
    expect(outcome.exitCode).toBe(0);
  });

  it("runs arbitrary .cmd wrappers with whitespace arguments", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-any-cmd-"));
    const wrapper = path.join(workspaceRoot, "tool.cmd");
    fs.writeFileSync(wrapper, "@echo off\r\nif \"%~1\"==\"hello world\" exit /b 0\r\nexit /b 9\r\n", "utf8");

    const outcome = await runResolvedExecutable(wrapper, ["hello world"], workspaceRoot, process.execPath);

    expect(outcome.status).toBe("executed");
    expect(outcome.exitCode).toBe(0);
  });

  it("keeps concurrent guard sessions isolated by session id", async () => {
    const workspaceA = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-a-"));
    const workspaceB = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-b-"));
    const sessionA = createGovernedSession(workspaceA);
    const sessionB = createGovernedSession(workspaceB);
    const serverA = startGuardDaemon(sessionA);
    const serverB = startGuardDaemon(sessionB);
    await Promise.all([once(serverA, "listening"), once(serverB, "listening")]);

    try {
      const [valid, crossSession] = await Promise.all([
        request(sessionA.socketPath, { sessionId: sessionA.sessionId, command: "echo ok", cwd: workspaceA }),
        request(sessionB.socketPath, { sessionId: sessionA.sessionId, command: "echo ok", cwd: workspaceB }),
      ]);

      expect(valid.decision).toBe("allow");
      expect(crossSession.decision).toBe("block");
      expect(crossSession.reason).toContain("Invalid or missing Termyte session");
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => serverA.close(() => resolve())),
        new Promise<void>((resolve) => serverB.close(() => resolve())),
      ]);
    }
  });

  it("removes Unix socket files when the guard daemon closes", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-shell-"));
    const session = createGovernedSession(workspaceRoot);
    const server = startGuardDaemon(session);
    await once(server, "listening");

    expect(fs.existsSync(session.socketPath)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(fs.existsSync(session.socketPath)).toBe(false);
  });
});
