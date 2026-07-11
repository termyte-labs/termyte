import { checkbox, confirm, select } from "@inquirer/prompts";
import { Store } from "../storage/store.js";
import { installFor } from "../integrations/installers/index.js";
import { createAdapter } from "../synth/index.js";
import {
  defaultUserConfig,
  saveUserConfig,
  type UserConfig,
} from "./config.js";

export interface InitChoices {
  agents: Array<"claude-code" | "codex">;
  synthesis: UserConfig["synthesis"];
  acceptedDisclosure: boolean;
}

export async function initCommand(): Promise<number> {
  const detected = await detectAgents();
  const agents = await checkbox<"claude-code" | "codex">({
    message: "Select coding agents for Termyte",
    required: true,
    choices: [
      { name: `Claude Code${detected.claudeCode ? " (detected)" : ""}`, value: "claude-code", checked: detected.claudeCode },
      { name: `Codex${detected.codex ? " (detected)" : ""}`, value: "codex", checked: detected.codex },
    ],
  });

  const providerChoices: Array<{ name: string; value: "claude-code" | "codex" | "api" | "capture-only" }> = [];
  if (agents.includes("codex")) providerChoices.push({ name: "Use existing Codex authentication (recommended)", value: "codex" });
  if (agents.includes("claude-code")) providerChoices.push({ name: "Use existing Claude Code authentication", value: "claude-code" });
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
  return initializeTermyte({ agents, synthesis, acceptedDisclosure });
}

export async function initializeTermyte(choices: InitChoices, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!choices.acceptedDisclosure) return 1;
  if (choices.agents.length === 0) throw new Error("Select at least one coding agent");
  if (choices.synthesis.mode === "api" && !(env.TERMYTE_LLM_API_KEY || env.OPENAI_API_KEY)) {
    throw new Error("Set TERMYTE_LLM_API_KEY before selecting API synthesis");
  }

  const config = defaultUserConfig(env);
  config.agents = [...new Set(choices.agents)];
  config.synthesis = choices.synthesis;
  saveUserConfig(config, env);
  const store = new Store(config.dbPath);
  store.recordAudit("initialize", "configuration", "user", { agents: config.agents, synthesis: config.synthesis.mode }, "init");
  store.close();

  const homeDir = env.HOME ?? env.USERPROFILE;
  for (const agent of config.agents) {
    const code = installFor(agent, { target: "user", homeDir });
    if (code !== 0) return code;
  }
  process.stdout.write("\nTermyte is ready. Continue using your coding agents normally.\nOpen Termyte with: termyte viewer\n");
  return 0;
}

async function detectAgents(): Promise<{ claudeCode: boolean; codex: boolean }> {
  const [claudeCode, codex] = await Promise.all([
    createAdapter("claude-code").isAvailable(),
    createAdapter("codex").isAvailable(),
  ]);
  return { claudeCode, codex };
}
