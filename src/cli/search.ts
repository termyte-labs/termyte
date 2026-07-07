import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { renderHybridResults } from "../context/builder.js";
import { parseRetrievalTypeName } from "../mcp/schemas.js";
import { DocumentStore, type DocumentType, type SparseHit } from "../storage/documents.js";
import { ALL_MEMORY_STATES } from "../retrieval/eligibility.js";
import { createEmbeddingsProvider } from "../runtime/providers.js";

export async function searchCommand(
  query: string,
  options: { repo_id?: string; limit?: number; json?: boolean; currentFiles?: string[]; type?: string; allStates?: boolean },
): Promise<void> {
  const parsedType = parseRetrievalTypeName(options.type);
  if (!parsedType.ok) throw new Error(parsedType.error.message);

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const documents = new DocumentStore(store.getDB());

  try {
    const limit = options.limit ?? 20;
    if (parsedType.value && parsedType.value !== "all" && parsedType.value !== "memory") {
      const hits = documents.searchSparse({
        query,
        types: [parsedType.value as DocumentType],
        limit,
        files: options.currentFiles,
      });
      if (options.json) process.stdout.write(JSON.stringify(hits, null, 2) + "\n");
      else process.stdout.write(renderDocumentHits(hits));
      return;
    }

    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const embeddings = createEmbeddingsProvider(config.embeddings.model);
    const search = new HybridSearch({ fts, vector, embeddings, feedbackStore: store });
    const results = await search.search({
      query,
      repo_id: options.repo_id,
      limit,
      currentFiles: options.currentFiles,
      eligibleStates: options.allStates ? ALL_MEMORY_STATES : undefined,
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

function renderDocumentHits(hits: SparseHit[]): string {
  if (hits.length === 0) return "(no results)\n";
  return hits.map((hit) => {
    const doc = hit.document;
    const files = doc.files.length > 0 ? `\n  files: ${doc.files.join(", ")}` : "";
    return `# ${doc.id} [${doc.doc_type}] score=${hit.score.toFixed(3)}\n${doc.content}${files}`;
  }).join("\n\n") + "\n";
}
