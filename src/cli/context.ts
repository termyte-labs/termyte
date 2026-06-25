/**
 * `termyte context [--project <p>] [--query <q>] [--limit <n>]`
 *
 * Renders a project-level context block: a recent summary (if any) plus
 * a list of memories. When `--query` is supplied, the memories are
 * selected by hybrid search; otherwise the most-recent N are returned.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { ContextBuilder } from "../context/builder.js";

export async function contextCommand(options: {
  project?: string;
  query?: string;
  limit?: number;
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
    const project = options.project ?? "default";
    const result = await builder.build({
      project,
      query: options.query,
      maxMemories: options.limit ?? 50,
    });
    process.stdout.write(result.text + "\n");
  } finally {
    store.close();
  }
}
