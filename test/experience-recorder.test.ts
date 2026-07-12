import { describe, expect, it } from "vitest";
import { Store } from "../src/storage/store.js";
import { openDatabase } from "../src/storage/connection.js";
import { ExperienceRecorder } from "../src/experience/recorder.js";
import type { NormalizedEvent } from "../src/capture/adapter.js";

describe("ExperienceRecorder", () => {
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
    expect(store.getEpisode(firstEpisodeId)?.status).toBe("unknown");
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
