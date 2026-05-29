import { describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import {
  buildGuardCommand,
  buildSessionEnv,
  buildUnixShimScript,
  buildWindowsShimScript,
  createGovernedSession,
  handleGuardRequest,
  resolveRealExecutable,
  startGuardDaemon,
} from "../src/shell.js";

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
    expect(env.PATH?.startsWith(session.shimDir)).toBe(true);
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
