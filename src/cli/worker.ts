/**
 * `termyte-worker` - standalone observer process.
 *
 * Polls the `traces` table for unprocessed rows, runs the observer on
 * them, and exits when the queue is empty. Designed to be run by a
 * cron, a systemd timer, or a long-lived supervisor; it does not
 * daemonize itself.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { Observer } from "../observer/pipeline.js";
import { OpenAICompatibleProvider } from "../observer/openai-provider.js";
import { LocalEmbeddingsProvider } from "../retrieval/local-embeddings.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(config.dbPath);
  const llm = new OpenAICompatibleProvider(config.llm);
  const embeddings = new LocalEmbeddingsProvider({ model: config.embeddings.model });
  const observer = new Observer({ store, llm, embeddings });

  try {
    let totalProcessed = 0;
    // Loop until no more unprocessed traces.
    // The `--once` flag stops after a single pass for testing.
    for (;;) {
      const processed = await observer.processUnprocessedOnce(50);
      if (processed === 0) break;
      totalProcessed += processed;
      if (args.once) break;
    }
    process.stdout.write(`termyte-worker: processed ${totalProcessed} trace(s)\n`);
  } catch (err) {
    process.stderr.write(`termyte-worker: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

function parseArgs(argv: string[]): { once: boolean } {
  return { once: argv.includes("--once") };
}

main();
