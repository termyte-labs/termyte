import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { Observer } from "../src/context/observations/pipeline.js";
import { FakeLLMProvider } from "../src/context/observations/fake-provider.js";
import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from "../src/context/observations/provider.js";
import { NoOpEmbeddingsProvider } from "../src/context/retrieval/embeddings.js";
import { HookRunner } from "../src/agents/hooks/runner.js";
import { MemoryPipeline } from "../src/context/pipeline/memory-pipeline.js";
import { JobQueue } from "../src/context/pipeline/job-queue.js";
import { FTSSearch } from "../src/context/retrieval/fts.js";
import { VectorSearch } from "../src/context/retrieval/vector.js";
import { HybridSearch } from "../src/context/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";

class GateLLM implements LLMProvider {
  calls = 0;
  fail = true;
  private readonly fake = new FakeLLMProvider();

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    this.calls++;
    if (this.fail) throw new Error("context gate injected provider failure");
    return this.fake.chat(messages, options);
  }
}

describe("context engine release gate", () => {
  it("bounds episode work, recovers, preserves provenance, and abstains", async () => {
    const store = new Store(openDatabase(":memory:"));
    const llm = new GateLLM();
    const embeddings = new NoOpEmbeddingsProvider();
    const observer = new Observer({ store, llm, embeddings });
    const runner = new HookRunner({ store, observer });

    try {
      for (let index = 0; index < 100; index++) {
        expect(await runner.processRaw("raw", {
          session_id: "gate-session", cwd: "/repo", timestamp: 1_700_000_000_000 + index,
          tool_name: "Bash", tool_input: { command: "npm test", file_path: "src/app.ts" },
          tool_output: { status: "ok" },
        })).toBe(true);
      }

      const db = store.getDB();
      expect((db.prepare("SELECT COUNT(*) AS count FROM traces").get() as { count: number }).count).toBe(100);
      expect((db.prepare("SELECT COUNT(*) AS count FROM episodes").get() as { count: number }).count).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE kind = 'synthesize_episode' AND state IN ('pending', 'leased', 'failed')").get() as { count: number }).count).toBe(1);

      const pipeline = new MemoryPipeline({ store, llm, embeddings });
      await pipeline.runUntilIdle("gate-failing", { maxJobs: 1, waitForScheduledMs: 1_500 });
      expect(pipeline.getQueueStats().failed).toBe(1);
      expect((db.prepare("SELECT COUNT(*) AS count FROM traces").get() as { count: number }).count).toBe(100);

      llm.fail = false;
      db.prepare("UPDATE jobs SET next_run_at = ?, lease_until = ? WHERE state = 'failed'").run(Date.now(), Date.now() - 1);
      const queue = new JobQueue(db);
      const crashed = queue.claimNextJob("gate-crashed", { nowMs: Date.now(), leaseMs: 60_000 });
      expect(crashed).not.toBeNull();
      db.prepare("UPDATE jobs SET lease_until = ? WHERE id = ?").run(Date.now() - 1, crashed!.id);

      const processed = await pipeline.runUntilIdle("gate-recovered", { maxJobs: 30, waitForScheduledMs: 1_500 });
      expect(processed).toBeGreaterThan(0);
      expect(pipeline.getQueueStats().pending).toBe(0);
      expect(pipeline.getQueueStats().leased).toBe(0);
      expect(pipeline.getQueueStats().failed).toBe(0);
      expect(llm.calls).toBeLessThan(100);
      expect((db.prepare("SELECT COUNT(*) AS count FROM traces WHERE processed_at IS NOT NULL").get() as { count: number }).count).toBe(100);
      expect((db.prepare("SELECT COUNT(*) AS count FROM episode_traces").get() as { count: number }).count).toBe(100);

      const search = new HybridSearch({
        fts: new FTSSearch(store), vector: new VectorSearch(store), embeddings, feedbackStore: store,
      });
      const context = new ContextBuilder(store, search);
      const episode = store.getEpisodes({ sessionId: "gate-session" })[0]!;
      const related = await context.build({
        repo_id: "unknown", sessionId: "gate-session", episodeId: episode.id,
        query: "npm test src/app.ts", currentFiles: ["src/app.ts"], tokenBudget: 800, surface: "test",
      });
      const relatedCandidates = store.getContextCandidates(related.contextPacketId);
      expect(relatedCandidates.some((candidate) => candidate.selected)).toBe(true);
      expect(relatedCandidates.every((candidate) => Object.keys(candidate.score_breakdown).length > 0)).toBe(true);

      const unrelated = await context.build({
        repo_id: "unrelated-repo",
        query: "quantum banana ocean", currentFiles: ["unrelated/planet.rs"], tokenBudget: 800, surface: "test",
      });
      expect(unrelated.text).toBe("");
      expect(unrelated.memories).toHaveLength(0);
      expect(store.getContextCandidates(unrelated.contextPacketId).some((candidate) => candidate.selected)).toBe(false);
      expect(unrelated.contextInjectionId).toBeNull();
    } finally {
      store.close();
    }
  });
});
