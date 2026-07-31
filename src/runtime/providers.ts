import type { OpenAIProviderConfig } from "../context/observations/openai-provider.js";
import { OpenAICompatibleProvider } from "../context/observations/openai-provider.js";
import { FakeLLMProvider } from "../context/observations/fake-provider.js";
import type { LLMProvider } from "../context/observations/provider.js";
import type { EmbeddingsProvider } from "../context/retrieval/embeddings.js";
import { NoOpEmbeddingsProvider } from "../context/retrieval/embeddings.js";
import { LocalEmbeddingsProvider, type LocalModelId } from "../context/retrieval/local-embeddings.js";
import { AgentCliLLMProvider, CaptureOnlyLLMProvider } from "../context/observations/agent-cli-provider.js";
import type { UserConfig } from "../cli/config.js";

export type RuntimeLlmProviderMode = "openai" | "fake";
export type RuntimeEmbeddingProviderMode = "local" | "noop";

export function createLLMProvider(
  config: OpenAIProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  synthesis: UserConfig["synthesis"] = { mode: "api" },
): LLMProvider {
  const mode = (env.TERMYTE_LLM_PROVIDER ?? "openai").toLowerCase();
  if (mode === "fake") return new FakeLLMProvider();
  if (synthesis.mode === "capture-only") return new CaptureOnlyLLMProvider();
  if (synthesis.mode === "agent" && synthesis.provider) return new AgentCliLLMProvider(synthesis.provider);
  return new OpenAICompatibleProvider(config);
}

export function createEmbeddingsProvider(
  model: LocalModelId | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingsProvider {
  const mode = (env.TERMYTE_EMBED_PROVIDER ?? "local").toLowerCase();
  if (mode === "noop" || mode === "none") return new NoOpEmbeddingsProvider();
  return new LocalEmbeddingsProvider({ model: model ?? undefined });
}
