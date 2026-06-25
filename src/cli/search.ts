import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { renderHybridResults } from "../context/builder.js";

export async function searchCommand(
  query: string,
  options: { repo_id?: string; limit?: number; json?: boolean; currentFiles?: string[] },
): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  const search = new HybridSearch({ fts, vector, embeddings });

  try {
    const limit = options.limit ?? 20;
    const results = await search.search({
      query,
      repo_id: options.repo_id,
      limit,
      currentFiles: options.currentFiles,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(results, jsonReplacer, 2) + "\n");
    } else {
      if (results.length === 0) { process.stdout.write("(no results)\n"); return; }
      process.stdout.write(renderHybridResults(results));
    }
  } finally { store.close(); }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  return value;
}
