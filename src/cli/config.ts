import type { OpenAIProviderConfig } from "../observer/openai-provider.js";
import type { OpenAIEmbeddingsConfig } from "../retrieval/embeddings.js";

export interface TermyteConfig {
  dbPath: string;
  llm: OpenAIProviderConfig;
  embeddings?: OpenAIEmbeddingsConfig;
}

/**
 * Load configuration from environment variables. All values have sensible
 * defaults; only the LLM and embedding API keys are required at runtime.
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

  const embKey = env.TERMYTE_EMBED_API_KEY ?? env.OPENAI_API_KEY;
  const embeddings: OpenAIEmbeddingsConfig | undefined = embKey
    ? {
        baseUrl:
          env.TERMYTE_EMBED_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
        apiKey: embKey,
        model: env.TERMYTE_EMBED_MODEL ?? "text-embedding-3-small",
        dimensions: parseInt(env.TERMYTE_EMBED_DIMENSIONS ?? "1536", 10) || 1536,
      }
    : undefined;

  return {
    dbPath: env.TERMYTE_DB ?? "./termyte.db",
    llm,
    embeddings,
  };
}
