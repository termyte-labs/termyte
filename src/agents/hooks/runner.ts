import type { Store } from "../../storage/store.js";
import type { Platform } from "../../shared/types.js";
import { adapterFor } from "../../capture/index.js";
import { Ingestor } from "../../capture/ingest.js";
import type { NormalizedEvent } from "../../capture/adapter.js";
import { AdapterRejectedInput } from "../../capture/errors.js";
import { detectRepoId, detectWorkspaceRoot } from "../../capture/git-state.js";

export class HookRunner {
  private readonly ingestor: Ingestor;

  constructor(private readonly store: Store) {
    this.ingestor = new Ingestor(store);
  }

  async processRaw(platform: Platform, raw: unknown): Promise<NormalizedEvent | null> {
    const adapter = adapterFor(platform);
    let event: NormalizedEvent | null;
    try { event = adapter.normalize(raw); }
    catch (error) {
      if (error instanceof AdapterRejectedInput) return null;
      throw error;
    }
    if (!event) return null;
    const workspaceRoot = detectWorkspaceRoot(event.cwd);
    const repoId = detectRepoId(event.cwd) ?? "unknown";
    this.store.migrateLegacyLocalRepository(projectName(workspaceRoot).toLowerCase(), repoId, workspaceRoot);
    this.store.upsertSession(event.session_id, projectName(workspaceRoot), repoId, workspaceRoot);
    this.ingestor.ingest(event);
    if (event.event_type === "assistant_message" || event.event_type === "session_end") {
      this.store.endSession(event.session_id, event.timestamp);
      const traces = this.store.getTracesForSession(event.session_id);
      const meaningful = traces.some((trace) => trace.user_prompt)
        && traces.some((trace) => trace.event_type === "tool_use" || trace.final_response);
      if (meaningful && repoId !== "unknown") {
        this.store.enqueueReflectionJob(repoId, event.session_id, event.timestamp);
      }
    }
    return event;
  }
}

function projectName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}
