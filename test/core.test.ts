import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { HookRunner } from "../src/agents/hooks/runner.js";
import { installClaudeCodeHooks } from "../src/agents/installers/claude-code.js";
import { installCodexHooks } from "../src/agents/installers/codex.js";
import { initializeTermyte } from "../src/cli/init.js";
import { detectRepoId } from "../src/capture/git-state.js";

const temporary: string[] = [];
afterEach(() => {
  delete process.env.TERMYTE_HOOK_PATH;
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("minimal Termyte runtime", () => {
  it("captures every turn, redacts secrets, and retrieves a stored handoff", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "termyte-core-")); temporary.push(workspace);
    const store = new Store(openDatabase(":memory:"));
    const runner = new HookRunner(store);

    await runner.processRaw("codex", {
      session_id: "session-1", cwd: workspace, timestamp: 1,
      hook_event_name: "UserPromptSubmit", prompt: "Fix login with token sk-12345678901234567890",
    });
    await runner.processRaw("codex", {
      session_id: "session-1", cwd: workspace, timestamp: 2,
      hook_event_name: "PostToolUse", tool_name: "Bash",
      tool_input: { command: "npm test" }, tool_output: { status: "ok" },
    });
    const traces = store.getTracesForSession("session-1");
    expect(traces).toHaveLength(2);
    expect(JSON.stringify(traces)).not.toContain("sk-12345678901234567890");
    expect(JSON.stringify(traces)).toContain("[REDACTED:api_key]");

    const session = store.getSession("session-1")!;
    store.upsertSession("session-2", "repo", session.repo_id!, workspace);
    store.saveHandoff({
      sourceSessionId: "session-1", targetSessionId: "session-2", repoId: session.repo_id!,
      content: "What happened\nLogin was fixed.\n\nWhy\nTokens had whitespace.\n\nWhat remains\nRun the full suite.\n\nNext step\nRun npm test.",
    });
    expect(store.searchHandoffs(session.repo_id!, "why token decision")).toHaveLength(1);
    store.close();
  });

  it("installs capture, prompt context, and session briefing hooks", () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-hooks-")); temporary.push(home);
    process.env.TERMYTE_HOOK_PATH = join(process.cwd(), "dist", "cli", "hook.js");
    expect(installClaudeCodeHooks({ target: "user", homeDir: home })).toBe(0);
    expect(installCodexHooks({ target: "user", homeDir: home })).toBe(0);
    for (const file of [join(home, ".claude", "settings.json"), join(home, ".codex", "hooks.json")]) {
      const hooks = JSON.parse(readFileSync(file, "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      expect(Object.keys(hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
      expect(hooks.SessionStart![0]!.hooks[0]!.command).toContain("session-init");
      expect(hooks.UserPromptSubmit![0]!.hooks[0]!.command).toContain("prompt-context");
      expect(hooks.PostToolUse![0]!.hooks[0]!.command).toContain("capture");
      expect(hooks.Stop![0]!.hooks[0]!.command).toContain("capture");
    }
  });

  it("initializes user-level hooks once and removes old project hooks", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-global-home-")); temporary.push(home);
    const project = mkdtempSync(join(tmpdir(), "termyte-global-project-")); temporary.push(project);
    const oldTermyte = { matcher: "*", hooks: [{ type: "command", command: "node /old/termyte-hook codex capture" }] };
    const keep = { matcher: "*", hooks: [{ type: "command", command: "node other-hook.js" }] };
    mkdirSync(join(project, ".codex"), { recursive: true });
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".codex", "hooks.json"), JSON.stringify({ hooks: { Stop: [keep, oldTermyte] } }));
    writeFileSync(join(project, ".claude", "settings.json"), JSON.stringify({ hooks: { Stop: [oldTermyte] } }));

    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TERMYTE_HOME: join(home, ".termyte"),
      TERMYTE_HOOK_PATH: join(process.cwd(), "src", "cli", "hook.ts"),
    };
    expect(await initializeTermyte({ agent: "codex", agents: ["codex", "claude-code"] }, env, project)).toBe(0);

    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".termyte", "config.json"))).toBe(true);
    expect(readFileSync(join(project, ".codex", "hooks.json"), "utf8")).toContain("other-hook.js");
    expect(readFileSync(join(project, ".codex", "hooks.json"), "utf8")).not.toContain("termyte-hook");
    expect(readFileSync(join(project, ".claude", "settings.json"), "utf8")).not.toContain("termyte-hook");
  });

  it("keeps unrelated local projects separate even when folder names match", () => {
    const parentA = mkdtempSync(join(tmpdir(), "termyte-scope-a-")); temporary.push(parentA);
    const parentB = mkdtempSync(join(tmpdir(), "termyte-scope-b-")); temporary.push(parentB);
    const projectA = join(parentA, "same-name");
    const projectB = join(parentB, "same-name");
    mkdirSync(projectA);
    mkdirSync(projectB);

    const repoA = detectRepoId(projectA);
    const repoB = detectRepoId(projectB);
    expect(repoA).toMatch(/^local:[0-9a-f]{24}$/);
    expect(repoB).toMatch(/^local:[0-9a-f]{24}$/);
    expect(repoA).not.toBe(repoB);

    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("source-a", "same-name", repoA!, projectA);
    store.saveExperience({ id: "exp-a", repository_id: repoA!, source_session_id: "source-a", content: "Only project A", evidence: null });
    expect(store.listExperiences(repoA!)).toHaveLength(1);
    expect(store.listExperiences(repoB!)).toHaveLength(0);
    store.close();
  });

  it("moves matching legacy local history into the isolated repository scope", () => {
    const project = mkdtempSync(join(tmpdir(), "termyte-legacy-scope-")); temporary.push(project);
    const legacyRepoId = project.split(/[\\/]/).filter(Boolean).at(-1)!.toLowerCase();
    const repoId = detectRepoId(project)!;
    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("legacy-source", legacyRepoId, legacyRepoId, project);
    store.saveExperience({ id: "legacy-exp", repository_id: legacyRepoId, source_session_id: "legacy-source", content: "Keep this project history", evidence: null });

    store.migrateLegacyLocalRepository(legacyRepoId, repoId, project);

    expect(store.listExperiences(legacyRepoId)).toHaveLength(0);
    expect(store.listExperiences(repoId)).toHaveLength(1);
    expect(store.getSession("legacy-source")?.repo_id).toBe(repoId);
    store.close();
  });
});
