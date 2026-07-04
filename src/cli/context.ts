import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { ContextBuilder } from "../context/builder.js";
import { parseRetrievalTypeName } from "../mcp/schemas.js";
import { DocumentStore, type DocumentType } from "../storage/documents.js";

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
  const documents = new DocumentStore(store.getDB());

  try {
    if (parsedType.value && parsedType.value !== "all" && parsedType.value !== "memory") {
      const hits = documents.searchSparse({
        query: options.query ?? "",
        files: options.currentFiles,
        types: [parsedType.value as DocumentType],
        limit: options.limit ?? 50,
      });
      process.stdout.write(renderDocumentContext(hits) + "\n");
      return;
    }

    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
    const search = new HybridSearch({ fts, vector, embeddings, feedbackStore: store });
    const builder = new ContextBuilder(store, search);
    const result = await builder.build({
      repo_id: options.repo_id,
      query: options.query,
      maxMemories: options.limit ?? 50,
      currentFiles: options.currentFiles,
      surface: "cli",
    });
    process.stdout.write(result.text + "\n");
    process.stderr.write(`termyte: context injection id: ${result.contextInjectionId}\n`);
  } finally {
    store.close();
  }
}

function renderDocumentContext(
  hits: ReturnType<DocumentStore["searchSparse"]>,
): string {
  if (hits.length === 0) return "# Termyte Context\n\n(no results)";
  return [
    "# Termyte Context",
    "",
    ...hits.flatMap((hit) => [
      `## ${hit.document.id} [${hit.document.doc_type}]`,
      hit.document.content,
      hit.document.files.length > 0 ? `Files: ${hit.document.files.join(", ")}` : "",
      "",
    ]),
  ].filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n").trimEnd();
}
