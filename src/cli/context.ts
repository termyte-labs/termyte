import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { ContextBuilder } from "../context/builder.js";

export async function contextCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
}): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const embeddings = config.embeddings
    ? new OpenAIEmbeddingsProvider(config.embeddings)
    : new NoOpEmbeddingsProvider();
  const search = new HybridSearch({ fts, vector, embeddings });
  const builder = new ContextBuilder(store, search);

  try {
    const result = await builder.build({
      repo_id: options.repo_id,
      query: options.query,
      maxMemories: options.limit ?? 50,
      currentFiles: options.currentFiles,
    });
    process.stdout.write(result.text + "\n");
  } finally {
    store.close();
  }
}
