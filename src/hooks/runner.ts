import type { Store } from "../storage/store.js";
import type { Observer } from "../observer/pipeline.js";
import type { Platform } from "../core/types.js";
import { adapterFor } from "../capture/index.js";
import { Ingestor } from "../capture/ingest.js";
import type { PlatformAdapter, NormalizedEvent } from "../capture/adapter.js";

export interface HookRunnerConfig {
  store: Store;
  observer?: Observer;
}

/**
 * Wire adapters to the ingestor and the in-process observer.
 *
 * Used by `src/cli/hook.ts` (the per-event hook binary) and tests.
 */
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
    };
  }

  /** Process a single raw event payload from a platform. */
  async processRaw(platform: Platform, raw: unknown): Promise<boolean> {
    const adapter = this.adapters[platform];
    const event = adapter.normalize(raw);
    if (!event) return false;
    await this.processEvent(event);
    return true;
  }

  /** Process a single normalized event. Upserts session, writes trace, kicks observer. */
  async processEvent(event: NormalizedEvent): Promise<void> {
    // Derive a project name from cwd if we can.
    if (event.cwd) {
      const project = deriveProjectName(event.cwd);
      this.store.upsertSession(event.session_id, project);
    }
    const trace = this.ingestor.ingest(event);
    if (this.observer) this.observer.enqueue(trace);
  }

  /** Read JSON from stdin, process it for the given platform. */
  async processStdin(platform: Platform): Promise<boolean> {
    const raw = await readStdin();
    if (!raw.trim()) return false;
    const parsed = JSON.parse(raw);
    return await this.processRaw(platform, parsed);
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

/** Project name: use the last path segment of cwd. */
function deriveProjectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
