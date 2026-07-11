import type { OpenAIProviderConfig } from "../observer/openai-provider.js";
import type { LocalModelId } from "../retrieval/local-embeddings.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SynthesisMode = "agent" | "api" | "capture-only";
export interface UserConfig {
  version: 1;
  dbPath: string;
  agents: Array<"claude-code" | "codex">;
  synthesis: { mode: SynthesisMode; provider?: "claude-code" | "codex" };
  llm?: { baseUrl?: string; model?: string };
}

export interface TermyteConfig {
  dbPath: string;
  llm: OpenAIProviderConfig;
  /**
   * Which local embedding model to use. Default: "nomic-embed" (Nomic Embed
   * Text v1.5, 768 dims). Models are downloaded once and cached locally by
   * @xenova/transformers — no API calls.
   */
  embeddings: { model: LocalModelId };
  synthesis: UserConfig["synthesis"];
}

/**
 * Load configuration from environment variables.
 *
 * Embeddings are always local (ONNX via @xenova/transformers). Only the LLM
 * API key is required at runtime, and only when the observer is invoked.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TermyteConfig {
  const user = loadUserConfig(env);
  const baseUrl = env.TERMYTE_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? user.llm?.baseUrl ?? "https://api.openai.com/v1";
  const apiKey = env.TERMYTE_LLM_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const model = env.TERMYTE_LLM_MODEL ?? user.llm?.model ?? "gpt-4o-mini";

  const llm: OpenAIProviderConfig = {
    baseUrl,
    apiKey,
    model,
  };

  const localModelRaw = (env.TERMYTE_EMBED_MODEL_LOCAL ?? "nomic-embed").toLowerCase();
  const localModel: LocalModelId = localModelRaw === "bge-small" ? "bge-small" : "nomic-embed";

  return {
    dbPath: env.TERMYTE_DB ?? user.dbPath,
    llm,
    embeddings: { model: localModel },
    synthesis: user.synthesis,
  };
}

export function termyteHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERMYTE_HOME ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".termyte");
}

export function userConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(termyteHome(env), "config.json");
}

export function defaultUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  return {
    version: 1,
    dbPath: join(termyteHome(env), "termyte.db"),
    agents: [],
    synthesis: { mode: "capture-only" },
  };
}

export function loadUserConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const fallback = defaultUserConfig(env);
  const path = userConfigPath(env);
  if (!existsSync(path)) return fallback;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<UserConfig>;
    return {
      ...fallback,
      ...parsed,
      agents: (parsed.agents ?? []).filter((agent): agent is "claude-code" | "codex" => agent === "claude-code" || agent === "codex"),
      synthesis: parsed.synthesis ?? fallback.synthesis,
      llm: parsed.llm,
    };
  } catch {
    return fallback;
  }
}

export function saveUserConfig(config: UserConfig, env: NodeJS.ProcessEnv = process.env): void {
  const path = userConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}
