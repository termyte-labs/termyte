import type { Store } from "../storage/store.js";
import type { Observer } from "../observer/pipeline.js";
import type { Platform } from "../core/types.js";
import { adapterFor } from "../capture/index.js";
import { Ingestor } from "../capture/ingest.js";
import type { PlatformAdapter, NormalizedEvent } from "../capture/adapter.js";
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";

export interface HookRunnerConfig {
  store: Store;
  observer?: Observer;
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
    };
  }

  async processRaw(platform: Platform, raw: unknown): Promise<boolean> {
    const adapter = this.adapters[platform];
    const event = adapter.normalize(raw);
    if (!event) return false;
    await this.processEvent(event);
    return true;
  }

  async processEvent(event: NormalizedEvent): Promise<void> {
    if (event.cwd) {
      const project = deriveProjectName(event.cwd);
      const repo_id = detectRepoId(event.cwd);
      const workspace_root = detectWorkspaceRoot(event.cwd);
      this.store.upsertSession(event.session_id, project, repo_id, workspace_root);
    } else {
      this.store.upsertSession(event.session_id, "unknown");
    }
    const trace = this.ingestor.ingest(event);
    if (this.observer) this.observer.enqueue(trace);
  }

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

function deriveProjectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}
