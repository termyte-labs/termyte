import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("packed MVP", () => {
  it("installs with only the CLI and hook, then captures a real hook payload", async () => {
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
    const hook = join(root, "dist", "cli", "hook.js");
    expect(existsSync(join(root, "dist", "cli", "index.js"))).toBe(true);
    expect(existsSync(hook)).toBe(true);
    expect(existsSync(join(root, "dist", "cli", "worker.js"))).toBe(false);

    const home = mkdtempSync(join(tmpdir(), "termyte-home-")); temporary.push(home);
    const db = join(home, "termyte.db");
    mkdirSync(join(home, ".termyte"), { recursive: true });
    writeFileSync(join(home, ".termyte", "config.json"), JSON.stringify({ version: 1, dbPath: db, agent: "codex" }));
    const captured = await run(process.execPath, [hook, "codex", "capture"], project, {
      ...process.env, HOME: home, USERPROFILE: home, TERMYTE_DB: db,
    }, JSON.stringify({ session_id: "packed-session", cwd: project, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: { status: "ok" } }));
    expect(captured.code, captured.stderr).toBe(0);
    expect(existsSync(db)).toBe(true);
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
