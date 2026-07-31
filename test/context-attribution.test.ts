import { describe, expect, it } from "vitest";
import { attributeEpisodeContext } from "../src/context/attribution.js";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { MemoryPipeline } from "../src/context/pipeline/memory-pipeline.js";
import { MockLLM } from "./mock-llm.js";

describe("context attribution", () => {
  it("runs attribution through the durable episode job", async () => {
    const setup = scenario({ files: [] });
    setup.store.recordEpisodeOutcome({
      episodeId: setup.episodeId, status: "unknown", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 5,
    });
    const pipeline = new MemoryPipeline({ store: setup.store, llm: new MockLLM() });

    expect(await pipeline.runOnce("worker-1")).toBe(true);
    expect(setup.store.getContextEffectsForEpisode(setup.episodeId)[0]?.verdict).toBe("unknown");
    setup.store.close();
  });

  it("records inferred helped once when applicable work succeeds", () => {
    const setup = scenario({ files: ["src/a.ts"] });
    setup.store.insertEvidence({
      episodeId: setup.episodeId, kind: "file", content: "src/a.ts",
      metadata: { modified: true }, observedAt: 5,
    });
    setup.store.insertEvidence({
      episodeId: setup.episodeId, kind: "test", content: "npm test",
      exitCode: 0, observedAt: 6,
    });
    setup.store.recordEpisodeOutcome({
      episodeId: setup.episodeId, status: "succeeded", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 7,
    });

    expect(attributeEpisodeContext(setup.store, setup.episodeId, 8)).toBe(1);
    expect(attributeEpisodeContext(setup.store, setup.episodeId, 9)).toBe(1);
    expect(setup.store.getContextEffectsForEpisode(setup.episodeId)[0]).toMatchObject({
      verdict: "helped", confidence: 0.65,
    });
    expect(setup.store.getMemoryFeedbackForMemory(setup.memoryId)
      .filter((row) => row.source === "inferred-effect")).toHaveLength(1);
    setup.store.close();
  });

  it("records explicit correction as hurt", () => {
    const setup = scenario({ files: ["src/a.ts"] });
    setup.store.recordEpisodeOutcome({
      episodeId: setup.episodeId, status: "failed", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 5,
    });
    setup.store.recordMemoryFeedback({
      id: `memory:${setup.memoryId}`, event: "corrected",
      contextInjectionId: setup.injectionId, correctionText: "Use src/b.ts instead",
      source: "test", nowMs: 6,
    });
    attributeEpisodeContext(setup.store, setup.episodeId, 7);
    const feedbackId = setup.store.getMemoryFeedbackForMemory(setup.memoryId).at(-1)?.id;

    expect(setup.store.getContextEffectsForEpisode(setup.episodeId)[0]).toMatchObject({
      verdict: "hurt", confidence: 0.95, feedback_id: feedbackId,
    });
    expect(setup.store.getMemory(setup.memoryId)?.lifecycle_state).toBe("conflicted");
    setup.store.close();
  });

  it("keeps no-signal context unknown without learning", () => {
    const setup = scenario({ files: [] });
    setup.store.recordEpisodeOutcome({
      episodeId: setup.episodeId, status: "succeeded", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 5,
    });
    attributeEpisodeContext(setup.store, setup.episodeId, 6);

    expect(setup.store.getContextEffectsForEpisode(setup.episodeId)[0]?.verdict).toBe("unknown");
    expect(setup.store.getMemoryFeedbackForMemory(setup.memoryId)).toHaveLength(0);
    setup.store.close();
  });

  it("records no overlap as unused without ignored feedback", () => {
    const setup = scenario({ files: ["src/a.ts"] });
    setup.store.insertEvidence({ episodeId: setup.episodeId, kind: "file", content: "src/b.ts", observedAt: 5 });
    setup.store.recordEpisodeOutcome({
      episodeId: setup.episodeId, status: "succeeded", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 6,
    });
    attributeEpisodeContext(setup.store, setup.episodeId, 7);

    expect(setup.store.getContextEffectsForEpisode(setup.episodeId)[0]).toMatchObject({ verdict: "unused", confidence: 0.6 });
    expect(setup.store.getMemoryFeedbackForMemory(setup.memoryId)).toHaveLength(0);
    setup.store.close();
  });

  it("keeps an injection linked to another task unknown", () => {
    const setup = scenario({ files: ["src/a.ts"] });
    setup.store.closeActiveEpisode("s1", "unknown", 5);
    const other = setup.store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/w", task: "Other", nowMs: 6 });
    setup.store.insertEvidence({ episodeId: other.id, kind: "file", content: "src/a.ts", observedAt: 7 });
    setup.store.recordEpisodeOutcome({
      episodeId: other.id, status: "succeeded", source: "inferred",
      contextInjectionId: setup.injectionId, nowMs: 8,
    });
    attributeEpisodeContext(setup.store, other.id, 9);

    expect(setup.store.getContextEffectsForEpisode(other.id)[0]?.verdict).toBe("unknown");
    setup.store.close();
  });
});

function scenario(input: { files: string[] }) {
  const store = new Store(openDatabase(":memory:"));
  store.upsertSession("s1", "demo", "r1", "/w");
  const episode = store.startEpisode({ sessionId: "s1", repoId: "r1", workspaceRoot: "/w", task: "Task", nowMs: 1 });
  const memory = store.insertMemory({
    session_id: "s1", repo_id: "r1", workspace_root: "/w",
    type: "procedure", title: "Procedure", description: "Follow the procedure",
    files_read: input.files, files_modified: [], source_observation_ids: [], source_trace_ids: [],
    created_at: 1, embedding: null,
  });
  const packet = store.recordContextPacket({
    sessionId: "s1", episodeId: episode.id, repoId: "r1", agent: "test", task: "Task",
    tokenBudget: 100, estimatedTokens: 5, retrievalMode: "fts", latencyMs: 1,
    renderedText: "context", candidates: [], nowMs: 2,
  });
  const injectionId = "inj-1";
  store.recordContextInjection({
    id: injectionId, sessionId: "s1", repoId: "r1", memoryIds: [memory.id],
    items: [{ memoryId: memory.id, rank: 1, score: 1, renderedText: "memory" }],
    surface: "test", packetId: packet.id, nowMs: 3,
  });
  return { store, episodeId: episode.id, memoryId: memory.id, injectionId };
}
