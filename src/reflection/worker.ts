import type { AgentClient } from "../llm/agent-client.js";
import type { Store } from "../storage/store.js";
import { ReflectionService } from "./service.js";

export class ReflectionWorker {
  constructor(private readonly store: Store, private readonly agent: AgentClient) {}

  async runOne(): Promise<boolean> {
    const job = this.store.claimReflectionJob();
    if (!job) return false;
    try {
      const session = this.store.getSession(job.source_session_id);
      if (!session) throw new Error("source session no longer exists");
      await new ReflectionService(this.store, this.agent).reflect(job.repository_id, job.source_session_id, session.workspace_root ?? undefined);
      this.store.completeReflectionJob(job.id);
    } catch (error) {
      this.store.failReflectionJob(job.id, error instanceof Error ? error.message : String(error));
    }
    return true;
  }

  async runUntilIdle(maxJobs = 20): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      if (await this.runOne()) { processed += 1; continue; }
      const delay = this.store.nextQueuedReflectionDelay();
      if (delay === null || delay > 5_000) break;
      await wait(Math.max(10, delay));
    }
    return processed;
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
