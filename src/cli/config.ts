import type { OpenAIProviderConfig } from "../observer/openai-provider.js";
import type { LocalModelId } from "../retrieval/local-embeddings.js";

export interface TermyteConfig {
  dbPath: string;
  llm: OpenAIProviderConfig;
  /**
   * Which local embedding model to use. Default: "nomic-embed" (Nomic Embed
   * Text v1.5, 768 dims). Models are downloaded once and cached locally by
   * @xenova/transformers — no API calls.
   */
  embeddings: { model: LocalModelId };
}

/**
 * Load configuration from environment variables.
 *
 * Embeddings are always local (ONNX via @xenova/transformers). Only the LLM
 * API key is required at runtime, and only when the observer is invoked.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): TermyteConfig {
  const baseUrl = env.TERMYTE_LLM_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const apiKey = env.TERMYTE_LLM_API_KEY ?? env.OPENAI_API_KEY ?? "";
  const model = env.TERMYTE_LLM_MODEL ?? "gpt-4o-mini";

  const llm: OpenAIProviderConfig = {
    baseUrl,
    apiKey,
    model,
  };

  const localModelRaw = (env.TERMYTE_EMBED_MODEL_LOCAL ?? "nomic-embed").toLowerCase();
  const localModel: LocalModelId = localModelRaw === "bge-small" ? "bge-small" : "nomic-embed";

  return {
    dbPath: env.TERMYTE_DB ?? "./termyte.db",
    llm,
    embeddings: { model: localModel },
  };
}
