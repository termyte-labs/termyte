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
import { Observer } from "../observer/pipeline.js";
import { OpenAICompatibleProvider } from "../observer/openai-provider.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";
import { HookRunner } from "../hooks/runner.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ContextBuilder } from "../context/builder.js";
import { adapterFor } from "../capture/index.js";
import type { Platform } from "../core/types.js";
import { getHandler, type HandlerInput } from "./handlers/index.js";

const KNOWN_PLATFORMS: Platform[] = ["claude-code", "codex", "opencode", "cursor", "gemini-cli", "windsurf", "raw"];

async function main(): Promise<void> {
  const platform = process.argv[2] as Platform | undefined;
  const eventName = process.argv[3];
  if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
    process.stderr.write(`usage: termyte-hook <${KNOWN_PLATFORMS.join("|")}> [event]\n`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const llm = new OpenAICompatibleProvider(config.llm);
  const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  const observer = new Observer({ store, llm, embeddings });
  const runner = new HookRunner({ store, observer });
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const search = new HybridSearch({ fts, vector, embeddings });
  const builder = new ContextBuilder(store, search);

  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stderr.write("termyte-hook: empty input\n");
      return;
    }
    const parsed = JSON.parse(raw);

    // Always ingest the trace; the runner swallows AdapterRejectedInput.
    await runner.processRaw(platform, parsed);

    if (!eventName) {
      // The trace and its extraction job are committed. A worker resumes it.
      return;
    }

    // Run the event handler. Re-normalize so the handler sees the same
    // shape the runner saw.
    const adapter = adapterFor(platform);
    let event;
    try {
      event = adapter.normalize(parsed);
    } catch {
      return;
    }
    if (!event) return;

    const handler = getHandler(eventName, { store, search, builder, observer });
    const input: HandlerInput = { event, raw: parsed };
    const out = await handler(input);
    const formatted = adapter.formatOutput(out.result);
    if (formatted && Object.keys(formatted as object).length > 0) {
      process.stdout.write(JSON.stringify(formatted) + "\n");
    }
  } catch (err) {
    process.stderr.write(`termyte-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
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
