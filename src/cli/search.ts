/**
 * `termyte search <query> [--project <p>] [--limit <n>] [--json]`
 *
 * Hybrid search over the memory store. The result is one of:
 *
 *   - Plain text (default): one block per result, showing id, type,
 *     title, subtitle, and a one-line snippet of the narrative.
 *   - JSON (`--json`): the raw `HybridSearchResult[]`.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { renderHybridResults } from "../context/builder.js";

export async function searchCommand(
  query: string,
  options: { project?: string; limit?: number; json?: boolean },
): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const embeddings = config.embeddings
    ? new OpenAIEmbeddingsProvider(config.embeddings)
    : new NoOpEmbeddingsProvider();
  const search = new HybridSearch({ fts, vector, embeddings });

  try {
    const limit = options.limit ?? 20;
    const results = await search.search({
      query,
      project: options.project,
      limit,
    });

    if (options.json) {
      process.stdout.write(JSON.stringify(results, jsonReplacer, 2) + "\n");
    } else {
      if (results.length === 0) {
        process.stdout.write("(no results)\n");
        return;
      }
      process.stdout.write(renderHybridResults(results));
    }
  } finally {
    store.close();
  }
}

/** JSON replacer that handles Float32Array by writing the underlying numbers. */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) {
    return Array.from(value);
  }
  return value;
}
