#!/usr/bin/env node

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
import { HookRunner } from "../hooks/runner.js";
import { FTSSearch } from "../retrieval/fts.js";
import { VectorSearch } from "../retrieval/vector.js";
import { HybridSearch } from "../retrieval/hybrid.js";
import { ContextBuilder } from "../context/builder.js";
import { adapterFor } from "../capture/index.js";
import type { Platform } from "../core/types.js";
import { getHandler, type HandlerInput } from "./handlers/index.js";
import { pathToFileURL } from "node:url";
import { createHookSupervisor, type WorkerSupervisor } from "../pipeline/worker-supervisor.js";
import { createLLMProvider } from "../runtime/providers.js";
import { NoOpEmbeddingsProvider } from "../retrieval/embeddings.js";

const KNOWN_PLATFORMS: Platform[] = ["claude-code", "codex", "raw"];

async function main(supervisorOverride?: WorkerSupervisor): Promise<void> {
  // Synthesis may itself invoke Claude Code or Codex. Those subprocesses
  // inherit the user's hooks, so they must be ignored before opening the
  // database or reading stdin; otherwise Termyte observes its own observer.
  if (isInternalSynthesis(process.env)) return;
  const platform = process.argv[2] as Platform | undefined;
  const eventName = process.argv[3];
  if (!platform || !KNOWN_PLATFORMS.includes(platform)) {
    process.stderr.write(`usage: termyte-hook <${KNOWN_PLATFORMS.join("|")}> [event]\n`);
    process.exitCode = 2;
    return;
  }

  const config = loadConfig();
  const store = new Store(config.dbPath);
  const llm = createLLMProvider(config.llm, process.env, config.synthesis);
  // Hooks must never download or initialize an embedding model on the agent's
  // foreground path. Hybrid retrieval degrades to FTS when this provider
  // declines the vector query; the background worker owns embedding work.
  const embeddings = new NoOpEmbeddingsProvider();
  const observer = new Observer({ store, llm, embeddings });
  const runner = new HookRunner({ store, observer });
  const fts = new FTSSearch(store);
  const vector = new VectorSearch(store);
  const search = new HybridSearch({ fts, vector, embeddings, feedbackStore: store });
  const builder = new ContextBuilder(store, search);
  const supervisor = supervisorOverride ?? createHookSupervisor(
    config.dbPath,
    config.synthesis.mode === "capture-only"
      ? { ...process.env, TERMYTE_AUTO_WORKER: "0" }
      : process.env,
  );

  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.stderr.write("termyte-hook: empty input\n");
      return;
    }
    const parsed = JSON.parse(raw);
    await processHookInput(platform, eventName, parsed, { runner, store, search, builder, observer, supervisor });
  } catch (err) {
    process.stderr.write(`termyte-hook: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

export interface HookDeps {
  runner: HookRunner;
  store: Store;
  search: HybridSearch;
  builder: ContextBuilder;
  observer: Observer;
  supervisor: WorkerSupervisor;
}

/**
 * Ingest a parsed hook payload, kick off worker supervision for the
 * enqueued job, and run any registered event handler. Exported so the
 * supervision wiring can be tested without spawning the CLI binary.
 */
export async function processHookInput(
  platform: Platform,
  eventName: string | undefined,
  raw: unknown,
  deps: HookDeps,
): Promise<void> {
  // Always ingest the trace; the runner swallows AdapterRejectedInput.
  const ingested = await deps.runner.processRaw(platform, raw);

  if (ingested) {
    // The trace and its extraction job are committed. Kick off a detached
    // worker to drain the durable queue without blocking the agent.
    deps.supervisor.maybeLaunch();
  }

  if (!eventName) {
    // The trace and its extraction job are committed. A worker resumes it.
    return;
  }

  // Run the event handler. Re-normalize so the handler sees the same
  // shape the runner saw.
  const adapter = adapterFor(platform);
  let event;
  try {
    event = adapter.normalize(raw);
  } catch {
    return;
  }
  if (!event) return;

  const handler = getHandler(eventName, { store: deps.store, search: deps.search, builder: deps.builder, observer: deps.observer });
  const input: HandlerInput = { event, raw };
  const out = await handler(input);
  const formatted = adapter.formatOutput(out.result);
  if (formatted && Object.keys(formatted as object).length > 0) {
    process.stdout.write(JSON.stringify(formatted) + "\n");
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

/** Entry point used by tests to inject a supervisor. Production callers
 *  run `main()` with no argument, which builds the default detached
 *  supervisor from the environment. */
export async function runHook(supervisor?: WorkerSupervisor): Promise<void> {
  return main(supervisor);
}

export function isInternalSynthesis(env: NodeJS.ProcessEnv): boolean {
  return env.TERMYTE_INTERNAL_SYNTHESIS === "1";
}

function isMainEntry(): boolean {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
}
if (isMainEntry()) void main();
