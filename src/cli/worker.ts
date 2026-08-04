#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { ExistingAgentClient } from "../llm/agent-client.js";
import { ReflectionWorker } from "../reflection/worker.js";
import { Store } from "../storage/store.js";

export async function runWorkerOnce(): Promise<number> {
  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    return await new ReflectionWorker(store, new ExistingAgentClient(config.agent)).runUntilIdle();
  } finally {
    store.close();
  }
}

function isMain(): boolean { try { return import.meta.url === pathToFileURL(process.argv[1] ?? "").href; } catch { return false; } }
if (isMain()) void runWorkerOnce().catch((error) => {
  process.stderr.write(`termyte-worker: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
