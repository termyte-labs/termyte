/**
 * `termyte-hook <platform> [event]` — reads a JSON hook payload from
 * stdin, normalizes via the platform adapter, ingests the trace, and
 * optionally runs a registered event handler. The handler's
 * `HookResult` is written to stdout as JSON for the agent to consume.
 *
 * Usage examples:
 *   termyte-hook claude-code                # legacy: single-event ingest
 *   termyte-hook claude-code session-init   # SessionStart → context handler
 *   termyte-hook claude-code observation    # PostToolUse → trace + no-op
 *   termyte-hook claude-code file-context   # PreToolUse Read → context inject
 *   termyte-hook claude-code summarize      # Stop → summary
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { HookRunner } from "../hooks/runner.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ContextBuilder } from "../context/builder.js";
import { adapterFor } from "../capture/index.js";
import { getEmbeddings } from "../retrieval/embeddings-singleton.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import type { Platform } from "../core/types.js";
import { getHandler, type HandlerInput } from "./handlers/index.js";

const KNOWN_PLATFORMS: Platform[] = ["claude-code", "codex", "opencode", "cursor", "gemini-cli", "windsurf", "raw"];

/** Event names that need the embeddings model loaded. The other
 *  events (observation, summarize, file-edit) are lean: they only
 *  touch the DB. Splitting the path avoids loading 130 MB of ONNX
 *  for a 200-tool-call session. */
const FAT_HANDLERS = new Set(["context", "session-init", "file-context"]);

async function main(): Promise<void> {
  const platform = process.argv[2] as Platform | undefined;
  const eventName = process.argv[3];
  if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
    process.stderr.write(`usage: termyte-hook <${KNOWN_PLATFORMS.join("|")}> [event]\n`);
    process.exit(2);
  }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  // Lean path: do NOT load embeddings eagerly. They are only needed
  // by the FAT handlers and are created lazily inside the branch.
  // No Observer either — the in-process LLM path is deprecated in
  // favor of termyte-synth's agent-adapter path.
  const runner = new HookRunner({ store });

  try {
    const ingest = await runner.processStdin(platform);
    if (!ingest.event) {
      process.exit(0);
    }
    if (!eventName) {
      process.exit(0);
    }

    // Lazy embeddings: only construct search/builder if a fat
    // handler needs them. Lean handlers return no-op.
    let search: HybridSearch | null = null;
    let builder: ContextBuilder | null = null;
    if (FAT_HANDLERS.has(eventName)) {
      const cached = getEmbeddings(config.embeddings.model);
      // Wait up to 2 s for the model to be warm. If not ready, the
      // handler will fall back to FTS-only via the NotReadyError
      // path (the HybridSearch catches it).
      await cached.ready;
      const fts = new FTSSearch(store);
      const vector = new VectorSearch(store);
      search = new HybridSearch({ fts, vector, embeddings: cached.provider });
      builder = new ContextBuilder(store, search);
    }

    const adapter = adapterFor(platform);
    const handler = getHandler(eventName, { store, search, builder });
    const input: HandlerInput = { event: ingest.event, raw: null };
    const out = await handler(input);
    const formatted = adapter.formatOutput(out.result);
    if (formatted && Object.keys(formatted as object).length > 0) {
      process.stdout.write(JSON.stringify(formatted) + "\n");
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(`termyte-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

/** Stub search that returns [] — used by lean handlers that don't
 *  actually search. */
function makeStubHybrid(store: Store): HybridSearch {
  return new HybridSearch({
    fts: new FTSSearch(store),
    vector: new VectorSearch(store),
    embeddings: new NoOpEmbeddingsProvider(),
  });
}
function makeStubContext(store: Store): ContextBuilder {
  return new ContextBuilder(store, makeStubHybrid(store));
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

main();
