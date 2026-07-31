import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeTermyte } from "../src/cli/init.js";

const homes: string[] = [];
afterEach(() => {
  delete process.env.TERMYTE_HOOK_PATH;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("termyte init", () => {
  it("creates a global config, database, and only selected agent hooks", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-init-")); homes.push(home);
    process.env.TERMYTE_HOOK_PATH = join(process.cwd(), "src", "cli", "hook.ts");
    const env = { ...process.env, HOME: home, USERPROFILE: home, TERMYTE_HOME: join(home, ".termyte") };

    const code = await initializeTermyte({
      agents: ["claude-code"],
      synthesis: { mode: "capture-only" },
      acceptedDisclosure: true,
    }, env);

    expect(code).toBe(0);
    const config = JSON.parse(readFileSync(join(home, ".termyte", "config.json"), "utf8"));
    expect(config.agents).toEqual(["claude-code"]);
    expect(config.synthesis.mode).toBe("capture-only");
    expect(existsSync(join(home, ".termyte", "termyte.db"))).toBe(true);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(false);
  });

  it("rejects API synthesis without an environment key", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-init-")); homes.push(home);
    const env = { HOME: home, USERPROFILE: home, TERMYTE_HOME: join(home, ".termyte") };
    await expect(initializeTermyte({
      agents: ["codex"], synthesis: { mode: "api" }, acceptedDisclosure: true,
    }, env)).rejects.toThrow("TERMYTE_LLM_API_KEY");
  });

  it("removes Termyte hooks from a deselected agent", async () => {
    const home = mkdtempSync(join(tmpdir(), "termyte-init-")); homes.push(home);
    process.env.TERMYTE_HOOK_PATH = join(process.cwd(), "src", "cli", "hook.ts");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
      theme: "dark",
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `node "C:\\pkg\\dist\\cli\\hook.js" claude-code context` }] }] },
    }));
    const env = { ...process.env, HOME: home, USERPROFILE: home, TERMYTE_HOME: join(home, ".termyte") };

    await initializeTermyte({ agents: ["codex"], synthesis: { mode: "capture-only" }, acceptedDisclosure: true }, env);

    const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(claude.theme).toBe("dark");
    expect(claude.hooks.UserPromptSubmit).toBeUndefined();
    expect(existsSync(join(home, ".codex", "hooks.json"))).toBe(true);
  });
});