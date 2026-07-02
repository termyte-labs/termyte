import type { Store } from "../storage/store.js";
import type { Observer } from "../observer/pipeline.js";
import type { Platform } from "../core/types.js";
import { adapterFor } from "../capture/index.js";
import { Ingestor } from "../capture/ingest.js";
import type { PlatformAdapter, NormalizedEvent, HookResult } from "../capture/adapter.js";
import { AdapterRejectedInput } from "../capture/errors.js";
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";

export interface HookRunnerConfig {
  store: Store;
  observer: Observer;
}

export class HookRunner {
  private store: Store;
  private observer: Observer;
  private ingestor: Ingestor;
  private adapters: Record<Platform, PlatformAdapter>;

  constructor(config: HookRunnerConfig) {
    this.store = config.store;
    this.observer = config.observer;
    this.ingestor = new Ingestor(this.store);
    this.adapters = {
      "claude-code": adapterFor("claude-code"),
      "codex": adapterFor("codex"),
      "opencode": adapterFor("opencode"),
      "cursor": adapterFor("cursor"),
      "gemini-cli": adapterFor("gemini-cli"),
      "windsurf": adapterFor("windsurf"),
      "raw": adapterFor("raw"),
    };
  }

  /**
   * Normalize a raw payload and ingest it. Returns true on success, false
   * if the adapter produced null (unparseable input) or threw
   * AdapterRejectedInput. Other errors propagate.
   */
  async processRaw(platform: Platform, raw: unknown): Promise<boolean> {
    const adapter = this.adapters[platform];
    let event: NormalizedEvent | null;
    try {
      event = adapter.normalize(raw);
    } catch (err) {
      if (err instanceof AdapterRejectedInput) {
        process.stderr.write(`termyte: ${err.reason}\n`);
        return false;
      }
      throw err;
    }
    if (!event) return false;
    await this.processEvent(event);
    return true;
  }

  async processEvent(event: NormalizedEvent): Promise<void> {
    const project = deriveProjectName(event.cwd);
    const repo_id = detectRepoId(event.cwd);
    const workspace_root = detectWorkspaceRoot(event.cwd);
    this.store.upsertSession(event.session_id, project, repo_id, workspace_root);
    const trace = this.ingestor.ingest(event);
    this.observer.enqueue(trace);
  }

  /**
   * Process a hook event, returning the result the agent should receive.
   * Used by event-handler dispatch in the CLI to inject context, deny
   * tool calls, etc.
   */
  async processForResult(platform: Platform, raw: unknown): Promise<{
    handled: boolean;
    output: unknown;
  }> {
    const adapter = this.adapters[platform];
    let event: NormalizedEvent | null;
    try {
      event = adapter.normalize(raw);
    } catch (err) {
      if (err instanceof AdapterRejectedInput) {
        return { handled: false, output: { continue: true, suppressOutput: true } };
      }
      throw err;
    }
    if (!event) return { handled: false, output: { continue: true } };
    await this.processEvent(event);
    return { handled: true, output: adapter.formatOutput({ continue: true }) };
  }

  async processStdin(platform: Platform): Promise<boolean> {
    const raw = await readStdin();
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw);
    return await this.processRaw(platform, parsed);
  }

  /** Format a HookResult through the platform's adapter envelope. */
  formatFor(platform: Platform, result: HookResult): unknown {
    return this.adapters[platform].formatOutput(result);
  }
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function deriveProjectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
