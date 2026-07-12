import { checkbox, confirm, select } from "@inquirer/prompts";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { Store } from "../storage/store.js";
import { installFor } from "../integrations/installers/index.js";
import { discoverAgentCapabilities, capabilityLabel, type SupportedAgent } from "../runtime/capabilities.js";
import { removeTermyteHookEntries } from "../integrations/installers/managed-hooks.js";
import {
  defaultUserConfig,
  saveUserConfig,
  userConfigPath,
  type UserConfig,
} from "./config.js";

export interface InitChoices {
  agents: Array<"claude-code" | "codex">;
  synthesis: UserConfig["synthesis"];
  acceptedDisclosure: boolean;
  synthesisVerified?: boolean;
}

export async function initCommand(): Promise<number> {
  process.stdout.write("Checking installed agents and authenticated synthesis paths...\n");
  const capabilities = await discoverAgentCapabilities({ verifySynthesis: true });
  const agents = await checkbox<"claude-code" | "codex">({
    message: "Select agents where Termyte should capture context",
    required: true,
    choices: capabilities.map((capability) => ({
      name: capabilityLabel(capability),
      value: capability.agent,
      checked: capability.synthesis === "ready",
    })),
  });

  const providerChoices: Array<{ name: string; value: "claude-code" | "codex" | "api" | "capture-only" }> = [];
  if (capabilities.some((c) => c.agent === "codex" && c.synthesis === "ready")) providerChoices.push({ name: "Use verified Codex authentication (recommended)", value: "codex" });
  if (capabilities.some((c) => c.agent === "claude-code" && c.synthesis === "ready")) providerChoices.push({ name: "Use verified Claude Code authentication", value: "claude-code" });
  providerChoices.push(
    { name: "Use an OpenAI-compatible API (TERMYTE_LLM_API_KEY)", value: "api" },
    { name: "Capture only for now", value: "capture-only" },
  );
  const selected = await select({ message: "How should Termyte form memories?", choices: providerChoices });
  const synthesis: UserConfig["synthesis"] = selected === "api" || selected === "capture-only"
    ? { mode: selected }
    : { mode: "agent", provider: selected };

  process.stdout.write("\nTermyte stores agent activity locally. Redacted trace-derived content is sent to the selected synthesis provider. Local embeddings may download once. No telemetry is enabled by default.\n\n");
  const acceptedDisclosure = await confirm({ message: "Continue with this configuration?", default: true });
  return initializeTermyte({ agents, synthesis, acceptedDisclosure, synthesisVerified: synthesis.mode !== "agent" || capabilities.some((c) => c.agent === synthesis.provider && c.synthesis === "ready") });
}

export async function initializeTermyte(choices: InitChoices, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!choices.acceptedDisclosure) return 1;
  if (choices.agents.length === 0) throw new Error("Select at least one coding agent");
  if (choices.synthesis.mode === "api" && !(env.TERMYTE_LLM_API_KEY || env.OPENAI_API_KEY)) {
    throw new Error("Set TERMYTE_LLM_API_KEY before selecting API synthesis");
  }
  if (choices.synthesis.mode === "agent" && !choices.synthesisVerified) {
    const verified = await discoverAgentCapabilities({ verifySynthesis: true });
    const provider = verified.find((item) => item.agent === choices.synthesis.provider);
    if (!provider || provider.synthesis !== "ready") {
      throw new Error(`${choices.synthesis.provider ?? "Selected agent"} cannot complete an authenticated noninteractive synthesis request${provider?.error ? `: ${provider.error}` : ""}`);
    }
  }

  const config = defaultUserConfig(env);
  config.agents = [...new Set(choices.agents)];
  config.synthesis = choices.synthesis;
  const homeDir = env.HOME ?? env.USERPROFILE ?? homedir();
  const hookPaths = {
    "claude-code": join(homeDir, ".claude", "settings.json"),
    codex: join(homeDir, ".codex", "hooks.json"),
  } satisfies Record<SupportedAgent, string>;
  const paths = [...Object.values(hookPaths), userConfigPath(env)];
  const snapshots = new Map(paths.map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  try {
    for (const agent of ["claude-code", "codex"] as SupportedAgent[]) {
      if (!config.agents.includes(agent)) removeTermyteHookEntries(hookPaths[agent]);
    }
    for (const agent of config.agents) {
      const code = installFor(agent, { target: "user", homeDir });
      if (code !== 0) throw new Error(`Failed to install ${agent} hooks`);
    }
    saveUserConfig(config, env);
    const store = new Store(config.dbPath);
    store.recordAudit("initialize", "configuration", "user", { agents: config.agents, synthesis: config.synthesis.mode }, "init");
    store.close();
  } catch (error) {
    for (const [path, content] of snapshots) restore(path, content);
    throw error;
  }
  process.stdout.write("\nTermyte is ready. Continue using your coding agents normally.\nOpen Termyte with: termyte viewer\n");
  return 0;
}

function restore(path: string, content: Buffer | null): void {
  if (content === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
