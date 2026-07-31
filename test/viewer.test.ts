import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { JobQueue } from "../src/context/pipeline/job-queue.js";
import { RetryableJobError } from "../src/context/pipeline/errors.js";
import { startViewerServer, type RunningViewerServer } from "../src/viewer/server.js";

let running: RunningViewerServer | null = null;
let store: Store | null = null;

afterEach(async () => {
  if (running) {
    await running.close();
    running = null;
  }
  if (store) {
    store.close();
    store = null;
  }
});

describe("viewer diagnostics server", () => {
  it("serves overview JSON on localhost", async () => {
    store = new Store(openDatabase(":memory:"));
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/overview`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.sessions).toBe(0);
    expect(body.data.memories).toBe(0);
    expect(body.data.health.queue.pending).toBe(0);
  });

  it("reports job summary counts", async () => {
    store = new Store(openDatabase(":memory:"));
    const queue = new JobQueue(store.getDB());
    queue.enqueueJob({ kind: "embed_memory", subjectType: "memory", subjectId: 1, nowMs: 100 });

    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/diagnostics`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.health.queue.pending).toBe(1);
    expect(body.data.health.queue.ready).toBe(1);
    expect(body.data.health.queue.oldestReadyAgeMs).toBeGreaterThan(0);
    expect(body.data.health.queue.failed).toBe(0);
    expect(body.data.health.queue.dead).toBe(0);
  });

  it("returns failed and dead jobs from dead-letter endpoint", async () => {
    store = new Store(openDatabase(":memory:"));
    const queue = new JobQueue(store.getDB());
    queue.enqueueJob({
      kind: "embed_observation",
      subjectType: "observation",
      subjectId: 1,
      nowMs: 100,
    });

    const claimed = queue.claimNextJob("viewer-test", { nowMs: 101 });
    expect(claimed).not.toBeNull();
    queue.markFailed(claimed!, new RetryableJobError("embedding timeout"), 102);

    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(`${running.url}/api/diagnostics`);
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.data.problemJobs).toHaveLength(1);
    expect(body.data.problemJobs[0].state).toBe("failed");
    expect(body.data.problemJobs[0].last_error).toContain("embedding timeout");
  });

  it("serves a minimal dashboard and shuts down cleanly", async () => {
    store = new Store(openDatabase(":memory:"));
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const response = await fetch(running.url);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("Termyte Viewer");

    await running.close();
    running = null;
  });

  it("exposes the episode, packet, injection, and outcome chain", async () => {
    store = new Store(openDatabase(":memory:"));
    store.upsertSession("s1", "repo", "repo-1", "/repo");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "repo-1", workspaceRoot: "/repo", task: "Fix capture" });
    const packet = store.recordContextPacket({
      id: "packet-viewer", sessionId: "s1", episodeId: episode.id, repoId: "repo-1",
      agent: "test", task: "Fix capture", tokenBudget: 200, estimatedTokens: 30,
      retrievalMode: "hybrid", latencyMs: 2, renderedText: "prior context",
      candidates: [{
        candidateId: "memory:1", kind: "memory", sourceId: "1", tokenEstimate: 30,
        selected: true, rank: 1, finalScore: 0.82,
        scoreBreakdown: { lexical: 0.5, path: 0.2, final: 0.82 }, renderedText: "prior context",
      }],
    });
    store.recordContextInjection({
      id: "injection-viewer", sessionId: "s1", repoId: "repo-1", memoryIds: [],
      surface: "hook", packetId: packet.id,
    });
    store.recordEpisodeOutcome({
      episodeId: episode.id, status: "succeeded", source: "viewer",
      contextInjectionId: "injection-viewer",
    });
    store.upsertContextEffect({
      injectionId: "injection-viewer", packetId: packet.id, episodeId: episode.id,
      candidateId: "memory:1", verdict: "helped", confidence: 0.8,
    });
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const episodeBody = await (await fetch(`${running.url}/api/episodes/${episode.id}`)).json() as any;
    expect(episodeBody.data.packets.map((row: any) => row.id)).toEqual(["packet-viewer"]);
    expect(episodeBody.data.injections.map((row: any) => row.id)).toEqual(["injection-viewer"]);
    expect(episodeBody.data.currentOutcome.context_injection_id).toBe("injection-viewer");
    expect(episodeBody.data.effects).toEqual([expect.objectContaining({ verdict: "helped", confidence: 0.8 })]);

    const packetBody = await (await fetch(`${running.url}/api/context-packets/${packet.id}`)).json() as any;
    expect(packetBody.data.abstained).toBe(false);
    expect(packetBody.data.candidates[0].score_breakdown).toEqual({ lexical: 0.5, path: 0.2, final: 0.82 });
  });

  it("exposes memory evidence and accepts only direct feedback events", async () => {
    store = new Store(openDatabase(":memory:"));
    store.upsertSession("s1", "repo", "repo-1", "/repo");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "repo-1", workspaceRoot: "/repo", task: "Validate" });
    const evidence = store.insertEvidence({ episodeId: episode.id, kind: "test", content: "npm test", exitCode: 0 });
    const memory = store.insertMemory({
      session_id: "s1", repo_id: "repo-1", workspace_root: "/repo", type: "fact",
      title: "Tests pass", description: "The focused suite passed", files_read: [], files_modified: [],
      source_observation_ids: [], source_trace_ids: [], created_at: 1, embedding: null,
    });
    store.linkMemoryEvidence(memory.id, [evidence.id]);
    running = await startViewerServer({ db: store.getDB(), port: 0 });

    const memoryBody = await (await fetch(`${running.url}/api/memories/${memory.id}`)).json() as any;
    expect(memoryBody.data.explanation.provenance_valid).toBe(true);
    expect(memoryBody.data.explanation.source_evidence[0].id).toBe(evidence.id);

    const csrf = await viewerCsrf(running.url);
    const invalid = await fetch(`${running.url}/api/memories/${memory.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json", "x-termyte-csrf": csrf },
      body: JSON.stringify({ event: "irrelevant" }),
    });
    expect(invalid.status).toBe(400);
    expect(store.getMemoryFeedbackForMemory(memory.id)).toHaveLength(0);

    const harmful = await fetch(`${running.url}/api/memories/${memory.id}/feedback`, {
      method: "POST", headers: { "content-type": "application/json", "x-termyte-csrf": csrf },
      body: JSON.stringify({ event: "harmful" }),
    });
    expect(harmful.status).toBe(200);
    expect(store.getMemoryFeedbackForMemory(memory.id)[0]?.event_type).toBe("harmful");
    expect(store.getMemory(memory.id)?.lifecycle_state).toBe("conflicted");
  });
});

async function viewerCsrf(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  const token = html.match(/<meta name="termyte-csrf" content="([^"]+)"/)?.[1];
  if (!token) throw new Error("Viewer CSRF token not found");
  return token;
}