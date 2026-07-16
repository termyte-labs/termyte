import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { ExperienceRecorder } from "../src/experience/recorder.js";
import type { NormalizedEvent } from "../src/capture/adapter.js";

describe("ExperienceRecorder", () => {
  it("stores episode commit boundaries and compact diff evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "termyte-recorder-git-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
      writeFileSync(join(root, "tracked.txt"), "initial\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Termyte Test", "-c", "user.email=test@termyte.invalid", "commit", "-qm", "initial"], { cwd: root, stdio: "ignore" });
      const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

      const store = new Store(openDatabase(":memory:"));
      const session = store.upsertSession("s1", "repo", "repo-1", root);
      const recorder = new ExperienceRecorder(store);
      const prompt = event({ event_type: "user_prompt", user_prompt: "Change tracked file", cwd: root });
      const episodeId = recorder.record(prompt, store.insertTrace(traceInput(prompt)), session)!;

      writeFileSync(join(root, "tracked.txt"), "committed\n");
      execFileSync("git", ["add", "tracked.txt"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["-c", "user.name=Termyte Test", "-c", "user.email=test@termyte.invalid", "commit", "-qm", "change"], { cwd: root, stdio: "ignore" });
      const finalCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      writeFileSync(join(root, "tracked.txt"), "working tree change\n");

      const end = event({ event_type: "session_end", timestamp: 3, cwd: root });
      recorder.record(end, store.insertTrace(traceInput(end)), session);

      expect(store.getEpisode(episodeId)).toMatchObject({ base_commit: baseCommit, final_commit: finalCommit });
      expect(store.getEvidenceForEpisode(episodeId)).toContainEqual(expect.objectContaining({
        kind: "diff",
        content: "tracked.txt",
        metadata: expect.objectContaining({ changed_paths: ["tracked.txt"] }),
      }));
      store.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("segments prompts into episodes and keeps deterministic evidence", () => {
    const store = new Store(openDatabase(":memory:"));
    const session = store.upsertSession("s1", "repo", "repo-1", "/repo");
    const recorder = new ExperienceRecorder(store);

    const first = event({ event_type: "user_prompt", user_prompt: "Fix the package" });
    const firstTrace = store.insertTrace({ ...traceInput(first) });
    const firstEpisodeId = recorder.record(first, firstTrace, session)!;

    const tool = event({
      event_type: "tool_use",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_output: { exit_code: 1, stderr: "failure" },
      files_read: ["package.json"],
    });
    const toolTrace = store.insertTrace({ ...traceInput(tool) });
    recorder.record(tool, toolTrace, session);

    const second = event({ event_type: "user_prompt", user_prompt: "Retry clean install", timestamp: 3 });
    const secondTrace = store.insertTrace({ ...traceInput(second) });
    const secondEpisodeId = recorder.record(second, secondTrace, session)!;

    expect(secondEpisodeId).not.toBe(firstEpisodeId);
    expect(store.getEpisode(firstEpisodeId)?.status).toBe("failed");
    expect(store.getCurrentEpisodeOutcome(firstEpisodeId)?.status).toBe("failed");
    expect(store.getActiveEpisode("s1")?.id).toBe(secondEpisodeId);
    expect(store.getEpisodeTraces(firstEpisodeId).map((trace) => trace.id)).toEqual([firstTrace.id, toolTrace.id]);
    expect(store.getEvidenceForEpisode(firstEpisodeId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "test", content: "npm test", exit_code: 1 }),
      expect.objectContaining({ kind: "file", content: "package.json" }),
    ]));
    store.close();
  });

  it("keeps a prompt continuation in the same episode until a state transition", () => {
    const store = new Store(openDatabase(":memory:"));
    const session = store.upsertSession("s1", "repo", "repo-1", "/repo");
    const recorder = new ExperienceRecorder(store);

    const first = event({ event_type: "user_prompt", user_prompt: "Fix the package" });
    const firstTrace = store.insertTrace(traceInput(first));
    const firstEpisodeId = recorder.record(first, firstTrace, session)!;
    const continuation = event({ event_type: "user_prompt", user_prompt: "Also update the lockfile", timestamp: 3 });
    const continuationTrace = store.insertTrace(traceInput(continuation));

    expect(recorder.record(continuation, continuationTrace, session)).toBe(firstEpisodeId);
    expect(store.getEpisodeTraces(firstEpisodeId).map((trace) => trace.id)).toEqual([firstTrace.id, continuationTrace.id]);
    store.close();
  });

  it("records append-only human outcomes", () => {
    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("s1", "repo", "repo-1", "/repo");
    const episode = store.startEpisode({ sessionId: "s1", repoId: "repo-1", workspaceRoot: "/repo", task: "Task" });
    store.recordEpisodeOutcome({ episodeId: episode.id, status: "failed", source: "inferred" });
    store.recordEpisodeOutcome({ episodeId: episode.id, status: "succeeded", source: "viewer", notes: "User verified" });

    expect(store.getEpisode(episode.id)?.status).toBe("succeeded");
    expect(store.getEpisodeOutcomes(episode.id).map((outcome) => outcome.status)).toEqual(["succeeded", "failed"]);
    expect(store.getCurrentEpisodeOutcome(episode.id)?.source).toBe("viewer");

    store.recordEpisodeOutcome({ episodeId: episode.id, status: "failed", source: "inferred" });
    expect(store.getCurrentEpisodeOutcome(episode.id)?.status).toBe("succeeded");
    expect(store.getEpisode(episode.id)?.status).toBe("succeeded");
    store.close();
  });

  it("links the inferred terminal outcome to the episode's latest injection", () => {
    const store = new Store(openDatabase(":memory:"));
    const session = store.upsertSession("s1", "repo", "repo-1", "/not-a-git-repo");
    const recorder = new ExperienceRecorder(store);
    const prompt = event({ event_type: "user_prompt", user_prompt: "Validate the package" });
    const episodeId = recorder.record(prompt, store.insertTrace(traceInput(prompt)), session)!;
    const packet = store.recordContextPacket({
      sessionId: "s1", episodeId, repoId: "repo-1", agent: "test", task: "Validate",
      tokenBudget: 100, estimatedTokens: 5, retrievalMode: "fts", latencyMs: 1,
      renderedText: "context", candidates: [], nowMs: 3,
    });
    store.recordContextInjection({
      id: "injection-exact", sessionId: "s1", repoId: "repo-1", memoryIds: [],
      surface: "hook", packetId: packet.id, nowMs: 4,
    });
    const tool = event({
      event_type: "tool_use", timestamp: 5, tool_name: "Bash",
      tool_input: { command: "npm test" }, tool_output: { exit_code: 0 },
    });
    recorder.record(tool, store.insertTrace(traceInput(tool)), session);
    const end = event({ event_type: "session_end", timestamp: 6 });
    recorder.record(end, store.insertTrace(traceInput(end)), session);

    expect(store.getCurrentEpisodeOutcome(episodeId)).toMatchObject({
      status: "succeeded", source: "inferred", context_injection_id: "injection-exact",
    });
    store.close();
  });

  it("finalizes an episode on Stop without ending the session", () => {
    const store = new Store(openDatabase(":memory:"));
    const session = store.upsertSession("s1", "repo", "repo-1", "/not-a-git-repo");
    const recorder = new ExperienceRecorder(store);
    const prompt = event({ event_type: "user_prompt", user_prompt: "Run tests" });
    const episodeId = recorder.record(prompt, store.insertTrace(traceInput(prompt)), session)!;
    const tool = event({
      event_type: "tool_use", timestamp: 3, tool_name: "Bash",
      tool_input: { command: "npm test" }, tool_output: { exit_code: 0 },
    });
    recorder.record(tool, store.insertTrace(traceInput(tool)), session);
    const stop = event({ event_type: "assistant_message", timestamp: 4, final_response: "Tests pass." });
    recorder.record(stop, store.insertTrace(traceInput(stop)), session);

    expect(store.getEpisode(episodeId)?.status).toBe("succeeded");
    expect(store.getCurrentEpisodeOutcome(episodeId)?.status).toBe("succeeded");
    expect(store.getActiveEpisode("s1")).toBeNull();
    expect(store.getSession("s1")?.ended_at).toBeNull();
    store.close();
  });
});

function event(overrides: Partial<NormalizedEvent>): NormalizedEvent {
  return {
    session_id: "s1",
    timestamp: 2,
    event_type: "tool_use",
    tool_name: null,
    tool_input: null,
    tool_output: null,
    files_read: null,
    files_modified: null,
    user_prompt: null,
    final_response: null,
    cwd: "/repo",
    ...overrides,
  };
}

function traceInput(input: NormalizedEvent) {
  return {
    session_id: input.session_id,
    timestamp: input.timestamp,
    event_type: input.event_type,
    tool_name: input.tool_name,
    tool_input: input.tool_input,
    tool_output: input.tool_output,
    files_read: input.files_read,
    files_modified: input.files_modified,
    user_prompt: input.user_prompt,
    final_response: input.final_response,
  };
}
