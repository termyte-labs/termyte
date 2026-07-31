import type { Store } from "../storage/store.js";
import type { Observer } from "../observer/pipeline.js";
import type { Platform } from "../core/types.js";
import { adapterFor } from "../capture/index.js";
import { Ingestor } from "../capture/ingest.js";
import type { PlatformAdapter, NormalizedEvent, HookResult } from "../capture/adapter.js";
import { AdapterRejectedInput } from "../capture/errors.js";
import { detectRepoId, detectWorkspaceRoot } from "../retrieval/local-embeddings.js";
import { ExperienceRecorder } from "../experience/recorder.js";
import { TaskDetectionService } from "../task-state/detection.js";

export interface HookRunnerConfig {
  store: Store;
  observer: Observer;
  /** Production uses one session consolidation at session end. */
  sessionConsolidation?: boolean;
}

export class HookRunner {
  private store: Store;
  private observer: Observer;
  private ingestor: Ingestor;
  private experience: ExperienceRecorder;
  private taskDetection: TaskDetectionService;
  private adapters: Record<Platform, PlatformAdapter>;
  private readonly sessionConsolidation: boolean;

  constructor(config: HookRunnerConfig) {
    this.store = config.store;
    this.observer = config.observer;
    this.sessionConsolidation = config.sessionConsolidation ?? false;
    this.ingestor = new Ingestor(this.store);
    this.experience = new ExperienceRecorder(this.store);
    this.taskDetection = new TaskDetectionService(this.store.getDB());
    this.adapters = {
      "claude-code": adapterFor("claude-code"),
      "codex": adapterFor("codex"),
      "opencode": adapterFor("opencode"),
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
    const repo_id = detectRepoId(event.cwd) ?? "unknown";
    const workspace_root = detectWorkspaceRoot(event.cwd) ?? event.cwd;
    const session = this.store.upsertSession(event.session_id, project, repo_id, workspace_root);
    const { trace, inserted } = this.ingestor.ingest(event);
    if (!inserted) return;
    const detection = this.taskDetection.detect({ event, traceId: trace.id, repoId: repo_id, workspaceRoot: workspace_root });
    const episodeId = this.experience.record(event, trace, session, detection.taskId);
    if (this.sessionConsolidation && event.event_type === "session_end") {
      this.observer.enqueueSession(event.session_id, Date.now());
    } else if (!this.sessionConsolidation && episodeId && (shouldEnqueueObservation(event) || event.event_type === "session_end")) {
      this.observer.enqueueEpisode(episodeId, event.event_type === "session_end" ? Date.now() : Date.now() + 1_000);
    }
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

export function shouldEnqueueObservation(event: NormalizedEvent): boolean {
  return event.event_type === "tool_use" && typeof event.tool_name === "string" && event.tool_name.length > 0;
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
