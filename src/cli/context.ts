import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { ContextBuilder } from "../context/builder.js";
import { parseRetrievalTypeName } from "../mcp/schemas.js";

export async function contextCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
  type?: string;
}): Promise<void> {
  const parsedType = parseRetrievalTypeName(options.type);
  if (!parsedType.ok) throw new Error(parsedType.error.message);

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  const search = new HybridSearch({ fts, vector, embeddings });
  const builder = new ContextBuilder(store, search);

  try {
    if (parsedType.value && parsedType.value !== "all" && parsedType.value !== "memory") {
      process.stdout.write("# Memory Context\n\n(no results for requested type in current memory-row retrieval engine)\n");
      return;
    }

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
