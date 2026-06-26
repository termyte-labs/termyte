/**
 * `termyte stats` — report unprocessed-trace counts, the configured
 * agent adapter (if any), and the local model. Local-only, never
 * phones home.
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { discoverAdapter } from "../synth/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const unprocessed = store.getUnprocessedTraces(10_000).length;
    const recent = store.getRecentSessions(10);
    const adapter = await discoverAdapter();
    const lines = [
      `db:                  ${config.dbPath}`,
      `embedding model:     ${config.embeddings.model} (local ONNX)`,
      `synthesis adapter:   ${adapter ?? "(none found — install Claude Code / Codex / OpenCode / Gemini CLI)"}`,
      `unprocessed traces:  ${unprocessed}${unprocessed >= 10_000 ? "+ (capped)" : ""}`,
      `recent sessions:     ${recent.length}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  } finally {
    store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`termyte: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

// Re-exported entry point so `termyte stats` can delegate here.
export async function runMain(): Promise<void> {
  await main();
}
