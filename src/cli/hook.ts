/**
 * `termyte-hook <platform>` - reads a JSON hook payload from stdin,
 * normalizes it via the platform adapter, ingests the trace, and
 * (optionally) flushes the in-process observer before exiting.
 *
 * The hook can be wired into any agent's hook protocol with a one-line
 * command substitution. For example, in a Claude Code `hooks.json`:
 *
 *   { "hooks": { "PostToolUse": [
 *       { "type": "command", "command": "termyte-hook claude-code" }
 *   ] } }
 */
import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { Observer } from "../observer/pipeline.js";
import { OpenAICompatibleProvider } from "../observer/openai-provider.js";
import { OpenAIEmbeddingsProvider, NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";
import { HookRunner } from "../hooks/runner.js";
import type { Platform } from "../core/types.js";

async function main(): Promise<void> {
  const platform = process.argv[2] as Platform | undefined;
  if (!platform || !isPlatform(platform)) {
    process.stderr.write("usage: termyte-hook <claude-code|codex|opencode|cursor>\n");
    process.exit(2);
  }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const llm = new OpenAICompatibleProvider(config.llm);
  const embeddings = config.embeddings
    ? new OpenAIEmbeddingsProvider(config.embeddings)
    : new NoOpEmbeddingsProvider();
  const observer = new Observer({ store, llm, embeddings });
  const runner = new HookRunner({ store, observer });

  try {
    const ok = await runner.processStdin(platform);
    if (!ok) {
      process.stderr.write("termyte-hook: empty or unparseable input\n");
    }
    // Always wait for the observer queue to drain before exiting. The
    // hook driver is short-lived; this is what makes the in-process mode
    // crash-safe (traces are marked processed atomically with their
    // memory writes).
    await observer.flush();
  } catch (err) {
    process.stderr.write(`termyte-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  } finally {
    store.close();
  }
}

function isPlatform(s: string): s is Platform {
  return s === "claude-code" || s === "codex" || s === "opencode" || s === "cursor";
}

main();
