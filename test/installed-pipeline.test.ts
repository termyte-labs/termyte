import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { detectRepoId } from "../src/capture/git-state.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("packed MVP", () => {
  it("packs the CLI and worker, captures a hook payload, and injects a briefing", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "termyte-pack-")); temporary.push(packDir);
    const npm = process.platform === "win32" ? "C:\\Users\\Palguna\\AppData\\Local\\nvm\\v22.12.0\\npm.cmd" : "npm";
    const packed = await run(npm, ["pack", "--json", "--pack-destination", packDir], process.cwd());
    expect(packed.code, packed.stderr).toBe(0);
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;

    const project = mkdtempSync(join(tmpdir(), "termyte-installed-")); temporary.push(project);
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proof-project", private: true }));
    const installed = await run(npm, ["install", "--no-package-lock", join(packDir, filename)], project);
    expect(installed.code, installed.stderr).toBe(0);

    const root = join(project, "node_modules", "termyte");
    const cli = join(root, "dist", "cli", "index.js");
    const hook = join(root, "dist", "cli", "hook.js");
    expect(existsSync(cli)).toBe(true);
    expect(existsSync(hook)).toBe(true);
    expect(existsSync(join(root, "dist", "cli", "worker.js"))).toBe(true);

    const home = mkdtempSync(join(tmpdir(), "termyte-home-")); temporary.push(home);
    const db = join(home, "termyte.db");
    const initialized = await run(process.execPath, [cli, "init"], project, {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TERMYTE_DB: db,
      CODEX_PATH: process.execPath,
      CLAUDE_PATH: join(home, "missing-claude"),
    });
    expect(initialized.code, initialized.stderr).toBe(0);
    expect(initialized.stdout).toContain("enabled globally");
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(project, ".codex", "hooks.json"))).toBe(false);
    expect(existsSync(join(home, ".termyte", "config.json"))).toBe(true);
    const captured = await run(process.execPath, [hook, "codex", "capture"], project, {
      ...process.env, HOME: home, USERPROFILE: home, TERMYTE_DB: db,
    }, JSON.stringify({ session_id: "packed-session", cwd: project, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: { status: "ok" } }));
    expect(captured.code, captured.stderr).toBe(0);
    expect(existsSync(db)).toBe(true);

    const started = await run(process.execPath, [hook, "codex", "session-init"], project, {
      ...process.env, HOME: home, USERPROFILE: home, TERMYTE_DB: db,
    }, JSON.stringify({ session_id: "next-session", cwd: project, hook_event_name: "SessionStart" }));
    expect(started.code, started.stderr).toBe(0);
    expect(started.stdout).toContain("Termyte project context");
  }, 180_000);

  it("traces the installed UserPromptSubmit editor path without injecting stored records", async () => {
    const packDir = mkdtempSync(join(tmpdir(), "termyte-context-pack-")); temporary.push(packDir);
    const npm = process.platform === "win32" ? "C:\\Users\\Palguna\\AppData\\Local\\nvm\\v22.12.0\\npm.cmd" : "npm";
    const packed = await run(npm, ["pack", "--json", "--pack-destination", packDir], process.cwd());
    expect(packed.code, packed.stderr).toBe(0);
    const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename;
    const project = mkdtempSync(join(tmpdir(), "termyte-context-installed-")); temporary.push(project);
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "proof-context", private: true }));
    const installed = await run(npm, ["install", "--no-package-lock", join(packDir, filename)], project);
    expect(installed.code, installed.stderr).toBe(0);
    const hook = join(project, "node_modules", "termyte", "dist", "cli", "hook.js");
    const home = mkdtempSync(join(tmpdir(), "termyte-context-home-")); temporary.push(home);
    const db = join(home, "termyte.db");
    const editorLog = join(home, "editor-input.txt");
    const fakeEditor = join(home, "fake-editor.mjs");
    const fakeCommand = join(home, "fake-editor.cmd");
    mkdirSync(join(home, ".termyte"), { recursive: true });
    writeFileSync(join(home, ".termyte", "config.json"), JSON.stringify({ version: 1, dbPath: db, agent: "claude-code" }));
    writeFileSync(fakeEditor, `import { readFileSync, writeFileSync } from "node:fs";\nconst input = readFileSync(0, "utf8");\nwriteFileSync(process.env.TERMYTE_EDITOR_LOG, input, "utf8");\nconst useful = input.includes("Fix login timeout test");\nprocess.stdout.write(JSON.stringify(useful ? { useful: true, experience_ids: ["exp-login"], context: "Use the fake clock reset for login timeout tests." } : { useful: false, experience_ids: [], context: "" }));\n`);
    writeFileSync(fakeCommand, `@echo off\r\n"${process.execPath}" "%~dp0fake-editor.mjs"\r\n`);
    const repoId = detectRepoId(project)!;
    const seed = new Store(openDatabase(db));
    seed.upsertSession("source-session", "proof-context", repoId, project);
    seed.saveExperience({
      id: "exp-login",
      repository_id: repoId,
      source_session_id: "source-session",
      content: "Lesson: Reset the fake clock before login timeout tests.\n\nWorked:\n- The reset made the test pass.\n\nUnfinished or uncertain:\n- Review and commit the current changes if desired.\n\nExplicit developer corrections:\n- Added strict validation.",
      evidence: JSON.stringify({ prompts: [{ trace_id: 10, text: "raw prompt" }], actions: [{ trace_id: 11, tool: "apply_patch", tool_input: { command: "raw patch" }, tool_output: "raw output" }] }),
    });
    seed.close();
    const baseEnv = { ...process.env, HOME: home, USERPROFILE: home, TERMYTE_DB: db, CLAUDE_PATH: fakeCommand, TERMYTE_EDITOR_LOG: editorLog };

    const casual = await run(process.execPath, [hook, "claude-code", "prompt-context"], project, baseEnv, JSON.stringify({ session_id: "casual-session", cwd: project, prompt: "Thanks, how are you doing?" }));
    expect(casual.code, casual.stderr).toBe(0);
    expect(casual.stdout).toBe("");

    const related = await run(process.execPath, [hook, "claude-code", "prompt-context"], project, baseEnv, JSON.stringify({ session_id: "related-session", cwd: project, prompt: "Fix login timeout test" }));
    expect(related.code, related.stderr).toBe(0);
    const relatedOutput = JSON.parse(related.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    const injected = relatedOutput.hookSpecificOutput?.additionalContext ?? "";
    expect(injected).toBe("Use the fake clock reset for login timeout tests.");
    expect(injected).not.toContain("raw prompt");
    expect(injected).not.toContain("raw patch");
    expect(injected).not.toContain("raw output");
    expect(injected).not.toContain("trace_id");
    expect(injected.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(250);
    expect(readFileSync(editorLog, "utf8")).toContain("Current request:\nFix login timeout test\n");

    const sessionStart = await run(process.execPath, [hook, "claude-code", "session-init"], project, baseEnv, JSON.stringify({ session_id: "briefing-session", cwd: project, hook_event_name: "SessionStart" }));
    expect(sessionStart.code, sessionStart.stderr).toBe(0);
    expect(sessionStart.stdout).toContain("Termyte project context");
    expect(sessionStart.stdout).not.toContain("Review and commit the current changes");
    expect(sessionStart.stdout).not.toContain("raw patch");

    const broken = join(home, "broken-editor.cmd");
    writeFileSync(broken, "@echo off\r\nexit /b 1\r\n");
    const fallback = await run(process.execPath, [hook, "claude-code", "prompt-context"], project, { ...baseEnv, CLAUDE_PATH: broken }, JSON.stringify({ session_id: "fallback-session", cwd: project, prompt: "Fix login timeout test" }));
    expect(fallback.code, fallback.stderr).toBe(0);
    const fallbackOutput = JSON.parse(fallback.stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    const fallbackContext = fallbackOutput.hookSpecificOutput?.additionalContext ?? "";
    expect(fallbackContext).toContain("fake clock");
    expect(fallbackContext).not.toContain("raw patch");
    expect(fallbackContext).not.toContain("trace_id");
    expect(fallbackContext.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(250);
  }, 180_000);
});

function run(file: string, args: string[], cwd: string, env = process.env, input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { cwd, env, windowsHide: true, shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(file), stdio: "pipe" });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
