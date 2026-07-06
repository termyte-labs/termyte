import type { OpenAIProviderConfig } from "../observer/openai-provider.js";
import { OpenAICompatibleProvider } from "../observer/openai-provider.js";
import { FakeLLMProvider } from "../observer/fake-provider.js";
import type { LLMProvider } from "../observer/provider.js";
import type { EmbeddingsProvider } from "../retrieval/embeddings.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { LocalEmbeddingsProvider, type LocalModelId } from "../retrieval/local-embeddings.js";

export type RuntimeLlmProviderMode = "openai" | "fake";
export type RuntimeEmbeddingProviderMode = "local" | "noop";

export function createLLMProvider(
  config: OpenAIProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): LLMProvider {
  const mode = (env.TERMYTE_LLM_PROVIDER ?? "openai").toLowerCase();
  if (mode === "fake") return new FakeLLMProvider();
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
