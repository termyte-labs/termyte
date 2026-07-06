import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { ContextBuilder } from "../context/builder.js";
import { parseRetrievalTypeName } from "../mcp/schemas.js";
import { DocumentStore, type DocumentType } from "../storage/documents.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function contextCommand(options: {
  repo_id?: string;
  query?: string;
  limit?: number;
  currentFiles?: string[];
  type?: string;
  writeFile?: string;
  json?: boolean;
  silent?: boolean;
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
      const markdown = renderDocumentContext(hits);
      if (options.silent) {
        return;
      }
      if (options.json) {
        process.stdout.write(JSON.stringify({
          markdown,
          selectedIds: hits.map((hit) => hit.document.id),
          estimatedTokens: Math.ceil(markdown.length / 4),
        }, null, 2) + "\n");
      } else {
        process.stdout.write(markdown + "\n");
      }
      return;
    }

    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const embeddings = options.query
      ? new LocalEmbeddingsProvider({ model: config.embeddings.model })
      : new NoOpEmbeddingsProvider();
    const search = new HybridSearch({ fts, vector, embeddings, feedbackStore: store });
    const builder = new ContextBuilder(store, search);
    const result = await builder.build({
      repo_id: options.repo_id,
      query: options.query,
      maxMemories: options.limit ?? 50,
      currentFiles: options.currentFiles,
      surface: "cli",
    });
    if (options.writeFile) {
      const path = options.writeFile;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, result.text, "utf-8");
    }
    if (options.silent) {
      return;
    }
    if (options.json) {
      process.stdout.write(JSON.stringify({
        markdown: result.text,
        selectedIds: result.memories.map((memory) => `memory:${memory.id}`),
        estimatedTokens: Math.ceil(result.text.length / 4),
        contextInjectionId: result.contextInjectionId,
      }, null, 2) + "\n");
    } else {
      process.stdout.write(result.text + "\n");
      process.stderr.write(`termyte: context injection id: ${result.contextInjectionId}\n`);
    }
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
