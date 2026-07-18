import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const npmCmd = process.platform === "win32" ? "C:\\nvm4w\\nodejs\\npm.cmd" : "npm";

describe("EVAL-002 packed installed pipeline", () => {
  let workDir: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalDb: string | undefined;
  let originalLlmProvider: string | undefined;
  let originalEmbedProvider: string | undefined;
  let originalAutoWorker: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "termyte-eval-install-"));
    homeDir = mkdtempSync(join(tmpdir(), "termyte-eval-home-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalDb = process.env.TERMYTE_DB;
    originalLlmProvider = process.env.TERMYTE_LLM_PROVIDER;
    originalEmbedProvider = process.env.TERMYTE_EMBED_PROVIDER;
    originalAutoWorker = process.env.TERMYTE_AUTO_WORKER;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TERMYTE_DB = join(homeDir, "termyte.db");
    process.env.TERMYTE_LLM_PROVIDER = "fake";
    process.env.TERMYTE_EMBED_PROVIDER = "noop";
    process.env.TERMYTE_AUTO_WORKER = "0";
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDb === undefined) delete process.env.TERMYTE_DB;
    else process.env.TERMYTE_DB = originalDb;
    if (originalLlmProvider === undefined) delete process.env.TERMYTE_LLM_PROVIDER;
    else process.env.TERMYTE_LLM_PROVIDER = originalLlmProvider;
    if (originalEmbedProvider === undefined) delete process.env.TERMYTE_EMBED_PROVIDER;
    else process.env.TERMYTE_EMBED_PROVIDER = originalEmbedProvider;
    if (originalAutoWorker === undefined) delete process.env.TERMYTE_AUTO_WORKER;
    else process.env.TERMYTE_AUTO_WORKER = originalAutoWorker;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("survives a packed install, an injected worker failure, and a recovery run", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "termyte-pack-"));
    const pack = await run(npmCmd, ["pack", "--json", "--pack-destination", packDir], { cwd: root });
    expect(pack.status, buildMessage("pack", pack)).toBe(0);

    const packInfo = JSON.parse(pack.stdout.trim()) as Array<{ filename: string }>;
    const tarball = join(packDir, packInfo[0]!.filename);
    expect(existsSync(tarball)).toBe(true);

    const projectDir = join(workDir, "project");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "package.json"), JSON.stringify({ name: "termyte-packed-test", private: true }, null, 2));

    const install = await run(npmCmd, ["install", "--no-package-lock", tarball], { cwd: projectDir });
    expect(install.status, buildMessage("install", install)).toBe(0);

    const pkgRoot = join(projectDir, "node_modules", "termyte");
    const indexCli = join(pkgRoot, "dist", "cli", "index.js");
    const workerCli = join(pkgRoot, "dist", "cli", "worker.js");
    const hookCli = join(pkgRoot, "dist", "cli", "hook.js");
    expect(existsSync(indexCli)).toBe(true);
    expect(existsSync(workerCli)).toBe(true);
    expect(existsSync(hookCli)).toBe(true);

    const previousHookPath = process.env.TERMYTE_HOOK_PATH;
    process.env.TERMYTE_HOOK_PATH = hookCli;
    try {
      const claudeInstaller = await import(pathToFileURL(join(pkgRoot, "dist", "integrations", "installers", "claude-code.js")).href);
      const codexInstaller = await import(pathToFileURL(join(pkgRoot, "dist", "integrations", "installers", "codex.js")).href);
      expect(claudeInstaller.installClaudeCodeHooks({ target: "user", homeDir })).toBe(0);
      expect(codexInstaller.installCodexHooks({ target: "user", homeDir })).toBe(0);
      for (const [file, agent] of [[join(homeDir, ".claude", "settings.json"), "claude-code"], [join(homeDir, ".codex", "hooks.json"), "codex"]]) {
        const hooks = JSON.parse(readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
        expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
        expect(hooks.Stop?.[0]?.hooks[0]?.command).toContain(`${agent} summarize`);
      }
    } finally {
      if (previousHookPath === undefined) delete process.env.TERMYTE_HOOK_PATH;
      else process.env.TERMYTE_HOOK_PATH = previousHookPath;
    }

    const failMarker = join(homeDir, "fake-llm-failed-once.marker");
    const baseEnv = {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      TERMYTE_DB: join(homeDir, "termyte.db"),
      TERMYTE_LLM_PROVIDER: "fake",
      TERMYTE_EMBED_PROVIDER: "noop",
      TERMYTE_AUTO_WORKER: "0",
      TERMYTE_FAKE_LLM_FAIL_ONCE: "1",
      TERMYTE_FAKE_LLM_FAIL_MARKER: failMarker,
    };

    for (const [handler, payload] of [
      ["context", { session_id: "installed-session", cwd: projectDir, hook_event_name: "UserPromptSubmit", prompt: "fix auth" }],
      ["observation", { session_id: "installed-session", cwd: projectDir, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "src/app.ts" } }],
      ["summarize", { session_id: "installed-session", cwd: projectDir, hook_event_name: "Stop", last_assistant_message: "Done" }],
      ["summarize", { session_id: "installed-session", cwd: projectDir, hook_event_name: "SessionEnd" }],
    ] as const) {
      const builtHook = await run(process.execPath, [hookCli, "claude-code", handler], {
        cwd: projectDir, env: baseEnv, input: JSON.stringify(payload) + "\n",
      });
      expect(builtHook.status, buildMessage(`built ${handler} hook`, builtHook)).toBe(0);
    }

    const doctor = await run(process.execPath, [indexCli, "doctor", "--json"], { cwd: projectDir, env: baseEnv });
    expect(doctor.status, buildMessage("doctor", doctor)).toBe(0);

    const tracePayload = {
      session_id: "installed-session",
      cwd: projectDir,
      timestamp: 1_700_000_000_000,
      tool_name: "Bash",
      tool_input: { command: "npm test", file_path: "src/app.ts" },
      tool_output: { status: "ok" },
    };
    const hook = await run(
      process.execPath,
      [hookCli, "raw"],
      { cwd: projectDir, env: baseEnv, input: JSON.stringify(tracePayload) + "\n" },
    );
    expect(hook.status, buildMessage("hook", hook)).toBe(0);

    const firstWorker = await run(process.execPath, [workerCli, "--until-idle", "--json"], { cwd: projectDir, env: baseEnv });
    expect(firstWorker.status, buildMessage("first worker", firstWorker)).toBe(0);
    const firstWorkerJson = JSON.parse(firstWorker.stdout.trim()) as {
      enqueued: number;
      jobsProcessed: number;
      queue: { pending: number; leased: number; succeeded: number; failed: number; dead: number };
    };
    expect(firstWorkerJson.jobsProcessed).toBeGreaterThan(0);
    expect(firstWorkerJson.queue.failed).toBeGreaterThan(0);
    expect(readFileSync(failMarker, "utf8")).toContain("failed-once");

    const firstHealth = await run(process.execPath, [indexCli, "doctor", "--json"], { cwd: projectDir, env: baseEnv });
    expect(firstHealth.status, buildMessage("doctor", firstHealth)).toBe(0);
    expect(JSON.parse(firstHealth.stdout).queue.failed).toBe(1);

    const secondEnv = { ...baseEnv, TERMYTE_FAKE_LLM_FAIL_ONCE: "0" };
    const rewind = await run(
      process.execPath,
      ["-e", `const Database = require("better-sqlite3"); const db = new Database(process.env.TERMYTE_DB); db.prepare("UPDATE jobs SET next_run_at = ? WHERE state = ?").run(Date.now(), "failed"); db.close();`],
      { cwd: projectDir, env: secondEnv, shell: false },
    );
    expect(rewind.status, buildMessage("rewind", rewind)).toBe(0);

    const secondWorker = await run(process.execPath, [workerCli, "--until-idle", "--json"], { cwd: projectDir, env: secondEnv });
    expect(secondWorker.status, buildMessage("second worker", secondWorker)).toBe(0);
    const secondWorkerJson = JSON.parse(secondWorker.stdout.trim()) as {
      enqueued: number;
      jobsProcessed: number;
      queue: { pending: number; leased: number; succeeded: number; failed: number; dead: number };
    };
    expect(secondWorkerJson.queue.succeeded).toBeGreaterThan(0);
    expect(secondWorkerJson.queue.failed).toBe(0);

    const memoryProof = await run(
      process.execPath,
      ["-e", `const Database = require("better-sqlite3"); const db = new Database(process.env.TERMYTE_DB); const row = db.prepare("SELECT COUNT(*) AS count FROM memories").get(); console.log(JSON.stringify(row)); db.close();`],
      { cwd: projectDir, env: secondEnv, shell: false },
    );
    expect(memoryProof.status, buildMessage("memory proof", memoryProof)).toBe(0);
    expect(JSON.parse(memoryProof.stdout).count).toBeGreaterThan(0);

    const contextProofScript = `
      import { pathToFileURL } from "node:url";
      const termyteModule = await import(pathToFileURL(process.argv[1]).href);
      const termyte = termyteModule.createTermyte({
        dbPath: process.env.TERMYTE_DB,
        llm: { baseUrl: "http://example.invalid", apiKey: "", model: "fake" },
        embeddings: { model: null }
      });
      try {
        const related = await termyte.context.build({
          repo_id: "unknown", query: "npm test src/app.ts", currentFiles: ["src/app.ts"],
          tokenBudget: 300, surface: "packed-test"
        });
        const relatedCandidates = termyte.store.getContextCandidates(related.contextPacketId);
        const unrelated = await termyte.context.build({
          repo_id: "packed-unrelated", query: "quantum banana ocean",
          currentFiles: ["unrelated/planet.rs"], tokenBudget: 300, surface: "packed-test"
        });
        const unrelatedCandidates = termyte.store.getContextCandidates(unrelated.contextPacketId);
        console.log(JSON.stringify({
          relatedSelected: relatedCandidates.filter((candidate) => candidate.selected).length,
          relatedRejectedHaveReasons: relatedCandidates.filter((candidate) => !candidate.selected)
            .every((candidate) => typeof candidate.rejection_reason === "string" && candidate.rejection_reason.length > 0),
          relatedHaveComponents: relatedCandidates.every((candidate) => Object.keys(candidate.score_breakdown).length > 0),
          unrelatedAbstained: unrelated.text === "" && unrelatedCandidates.every((candidate) => !candidate.selected),
          unrelatedInjectionId: unrelated.contextInjectionId
        }));
      } finally {
        termyte.close();
      }
    `;
    const contextProof = await run(
      process.execPath,
      ["--input-type=module", "-e", contextProofScript, join(pkgRoot, "dist", "index.js")],
      { cwd: projectDir, env: secondEnv, shell: false },
    );
    expect(contextProof.status, buildMessage("context proof", contextProof)).toBe(0);
    const contextProofJson = JSON.parse(contextProof.stdout.trim()) as {
      relatedSelected: number;
      relatedRejectedHaveReasons: boolean;
      relatedHaveComponents: boolean;
      unrelatedAbstained: boolean;
      unrelatedInjectionId: string | null;
    };
    expect(contextProofJson.relatedSelected).toBeGreaterThan(0);
    expect(contextProofJson.relatedRejectedHaveReasons).toBe(true);
    expect(contextProofJson.relatedHaveComponents).toBe(true);
    expect(contextProofJson.unrelatedAbstained).toBe(true);
    expect(contextProofJson.unrelatedInjectionId).toBeNull();
  });
}, 300_000);

function run(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; shell?: boolean },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: options.shell ?? true,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", (error) => { stderr += error.message; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(options.input);
  });
}

function buildMessage(step: string, result: { status: number | null; stdout: string; stderr: string }): string {
  return `${step} failed with status=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}
