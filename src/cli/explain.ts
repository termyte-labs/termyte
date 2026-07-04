import { loadConfig } from "./config.js";
import { Store } from "../storage/store.js";
import { buildMemoryExplain, renderMemoryExplain } from "../explain/memory-explain.js";

export async function explainCommand(options: { id?: string; json?: boolean }): Promise<void> {
  const id = options.id?.trim();
  if (!id) throw new Error("usage: termyte explain <id>");

  const config = loadConfig();
  const store = new Store(config.dbPath);
  try {
    const output = buildMemoryExplain(store, id);
    if (options.json) {
      process.stdout.write(JSON.stringify(output, jsonReplacer, 2) + "\n");
      return;
    }
    process.stdout.write(renderMemoryExplain(output));
  } finally {
    store.close();
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Float32Array) return Array.from(value);
  return value;
}
