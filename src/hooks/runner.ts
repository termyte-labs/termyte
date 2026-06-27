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
  observer?: Observer;
}

export interface ProcessRawResult {
  /** True if a NormalizedEvent was produced and ingest succeeded. */
  handled: boolean;
  /** The normalized event, if any. Re-used by callers to avoid re-normalizing. */
  event: NormalizedEvent | null;
  /** Human-readable error if ingest failed. */
  error?: string;
}

export class HookRunner {
  private store: Store;
  private observer?: Observer;
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
   * Normalize a raw payload and ingest it.
   *
   * Returns:
   *   - { handled: true, event } on success (caller can reuse `event`)
   *   - { handled: false, event: null } when the adapter returned null
   *   - { handled: false, event: null, error } on validation / FK failure
   *
   * The error is also written to stderr so the user can see *why* a
   * trace was rejected (previously this was silent).
   */
  async processRaw(platform: Platform, raw: unknown): Promise<ProcessRawResult> {
    const adapter = this.adapters[platform];
    let event: NormalizedEvent | null;
    try {
      event = adapter.normalize(raw);
    } catch (err) {
      if (err instanceof AdapterRejectedInput) {
        const msg = `adapter rejected input (${err.reason})`;
        process.stderr.write(`termyte: ${msg}\n`);
        return { handled: false, event: null, error: msg };
      }
      throw err;
    }
    if (!event) {
      return { handled: false, event: null };
    }
    try {
      await this.processEvent(event);
      return { handled: true, event };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`termyte: ingest failed for ${platform} session ${event.session_id}: ${msg}\n`);
      return { handled: false, event, error: msg };
    }
  }

  async processEvent(event: NormalizedEvent): Promise<void> {
    const project = deriveProjectName(event.cwd);
    const repo_id = detectRepoId(event.cwd);
    const workspace_root = detectWorkspaceRoot(event.cwd);
    this.store.upsertSession(event.session_id, project, repo_id, workspace_root);
    const trace = this.ingestor.ingest(event);
    if (this.observer) this.observer.enqueue(trace);
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
    try {
      await this.processEvent(event);
    } catch {
      return { handled: false, output: { continue: true, suppressOutput: true } };
    }
    return { handled: true, output: adapter.formatOutput({ continue: true }) };
  }

  async processStdin(platform: Platform): Promise<ProcessRawResult> {
    const raw = await readStdin();
    if (!raw.trim()) return { handled: false, event: null };
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      const msg = `stdin is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      process.stderr.write(`termyte: ${msg}\n`);
      return { handled: false, event: null, error: msg };
    }
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
