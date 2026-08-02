import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Platform } from "../shared/types.js";

export interface UserConfig {
  version: 1;
  dbPath: string;
  agent: Platform;
}

export function termyteHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMYTE_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".termyte");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(termyteHome(env), "config.json");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const fallback: UserConfig = { version: 1, dbPath: env.TERMYTE_DB ?? join(termyteHome(env), "termyte.db"), agent: "codex" };
  const path = userConfigPath(env);
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const legacySynthesis = parsed.synthesis as { provider?: unknown } | undefined;
    const legacyAgents = Array.isArray(parsed.agents) ? parsed.agents : [];
    const candidate = parsed.agent ?? legacySynthesis?.provider ?? legacyAgents[0];
    const agent: Platform = candidate === "claude-code" ? "claude-code" : "codex";
    return { version: 1, dbPath: env.TERMYTE_DB ?? (typeof parsed.dbPath === "string" ? parsed.dbPath : fallback.dbPath), agent };
  } catch { return fallback; }
}

export function saveUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): void {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
