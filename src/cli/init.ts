import { select } from "@inquirer/prompts";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Store } from "../storage/store.js";
import { installFor } from "../agents/installers/index.js";
import { removeTermyteHookEntries } from "../agents/installers/managed-hooks.js";
import { detectWorkspaceRoot } from "../capture/git-state.js";
import type { Platform } from "../shared/types.js";
import { saveUserConfig, termyteHome, userHome, type UserConfig } from "./config.js";

const execFileP = promisify(execFile);

export async function initCommand(): Promise<number> {
  const available: Platform[] = [];
  for (const agent of ["claude-code", "codex"] as const) {
    if (await agentAvailable(agent)) available.push(agent);
  }
  if (available.length === 0) throw new Error("Claude Code or Codex must be installed and signed in");
  const agent = available.length === 1 ? available[0]! : await select<Platform>({
    message: "Which coding agent should Termyte use?",
    choices: available.map((value) => ({ name: value === "codex" ? "Codex" : "Claude Code", value })),
  });
  return initializeTermyte({ agent, agents: available });
}

async function agentAvailable(agent: Platform): Promise<boolean> {
  const override = process.env[agent === "codex" ? "CODEX_PATH" : "CLAUDE_PATH"];
  if (override) return existsSync(override);
  try {
    await execFileP(process.platform === "win32" ? "where" : "which", [agent === "codex" ? "codex" : "claude"], { windowsHide: true });
    return true;
  } catch { return false; }
}

export async function initializeTermyte(input: { agent: Platform; agents?: Platform[] }, env: NodeJS.ProcessEnv = process.env, repoPath = process.cwd()): Promise<number> {
  const root = detectWorkspaceRoot(resolve(repoPath));
  const agents = [...new Set(input.agents?.length ? input.agents : [input.agent])];
  const config: UserConfig = {
    version: 1,
    dbPath: env.TERMYTE_DB ?? join(termyteHome(env), "termyte.db"),
    agent: input.agent,
    agents,
    briefingTokenLimit: 800,
    promptTokenLimit: 300,
    catalogueTokenLimit: 4_000,
    selectionTimeoutMs: 5_000,
  };
  for (const agent of agents) {
    const code = installFor(agent, { target: "user", homeDir: userHome(env) });
    if (code !== 0) throw new Error(`Failed to install ${agent} hooks`);
  }
  removeTermyteHookEntries(join(root, ".codex", "hooks.json"));
  removeTermyteHookEntries(join(root, ".claude", "settings.json"));
  saveUserConfig(config, env);
  const store = new Store(config.dbPath);
  store.close();
  process.stdout.write(`Termyte is enabled globally for ${agents.join(" and ")}. Context stays isolated by repository.\n`);
  return 0;
}
