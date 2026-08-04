import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookRunner } from "../src/agents/hooks/runner.js";
import { ContextBuilder } from "../src/context/builder.js";
import type { AgentClient } from "../src/llm/agent-client.js";
import { ReflectionWorker } from "../src/reflection/worker.js";
import { openDatabase } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

describe("experience loop", () => {
  it("turns one meaningful completed session into one evidence-linked experience", async () => {
    const workspace = project();
    const store = new Store(openDatabase(":memory:"));
    const runner = new HookRunner(store);
    await runner.processRaw("codex", { session_id: "s1", cwd: workspace, timestamp: 1, prompt: "Fix flaky login tests" });
    await runner.processRaw("codex", { session_id: "s1", cwd: workspace, timestamp: 2, tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: "one timeout failure" });
    await runner.processRaw("codex", { session_id: "s1", cwd: workspace, timestamp: 3, last_assistant_message: "Reset the fake clock and the tests pass." });

    expect(store.getReflectionJobForSession("s1")?.status).toBe("queued");
    const agent = new FakeAgent(JSON.stringify({
      lesson: "Reset the fake clock before login timeout tests.",
      worked: ["Resetting the fake clock made the test pass."],
      failed: ["Reusing clock state caused a timeout."],
      corrections: [], patterns: ["Login tests use a fake clock."], unfinished: [],
    }));
    expect(await new ReflectionWorker(store, agent).runOne()).toBe(true);

    const experience = store.getExperienceForSession("s1");
    expect(experience?.content).toContain("Reset the fake clock");
    expect(experience?.evidence).toContain("npm test");
    expect(experience?.source_session_id).toBe("s1");
    expect(store.getReflectionJobForSession("s1")?.status).toBe("completed");
    expect(await new ReflectionWorker(store, agent).runOne()).toBe(false);
    expect(store.listExperiences(store.getSession("s1")!.repo_id!)).toHaveLength(1);
    store.close();
  });

  it("does not create durable experience from malformed model output", async () => {
    const workspace = project();
    const store = new Store(openDatabase(":memory:"));
    const runner = new HookRunner(store);
    await runner.processRaw("claude-code", { session_id: "bad", cwd: workspace, timestamp: 1, prompt: "Change config" });
    await runner.processRaw("claude-code", { session_id: "bad", cwd: workspace, timestamp: 2, tool_name: "Edit", tool_input: { file_path: "config.ts" }, tool_output: "ok" });
    await runner.processRaw("claude-code", { session_id: "bad", cwd: workspace, timestamp: 3, last_assistant_message: "Done" });
    await new ReflectionWorker(store, new FakeAgent("not json")).runOne();
    expect(store.getExperienceForSession("bad")).toBeNull();
    expect(store.getReflectionJobForSession("bad")?.status).toBe("queued");
    expect(store.getReflectionJobForSession("bad")?.attempts).toBe(1);
    store.close();
  });

  it("retries a failed reflection in the detached worker", async () => {
    const workspace = project();
    const store = new Store(openDatabase(":memory:"));
    const runner = new HookRunner(store);
    await runner.processRaw("codex", { session_id: "retry", cwd: workspace, timestamp: 1, prompt: "Repair cache writes" });
    await runner.processRaw("codex", { session_id: "retry", cwd: workspace, timestamp: 2, tool_name: "Bash", tool_input: { command: "npm test" }, tool_output: "pass" });
    await runner.processRaw("codex", { session_id: "retry", cwd: workspace, timestamp: 3, last_assistant_message: "Used atomic rename." });
    const agent = new SequenceAgent(["not json", JSON.stringify({ lesson: "Use atomic rename for cache writes.", worked: ["The test passed."], failed: [], corrections: [], patterns: [], unfinished: [] })]);
    expect(await new ReflectionWorker(store, agent).runUntilIdle()).toBe(2);
    expect(store.getExperienceForSession("retry")?.content).toContain("atomic rename");
    expect(store.getReflectionJobForSession("retry")?.attempts).toBe(2);
    expect(store.getReflectionJobForSession("retry")?.status).toBe("completed");
    store.close();
  });

  it("briefs from all stored experiences and injects request-specific evidence", async () => {
    const workspace = project();
    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("old-1", "proof", "proof/repo", workspace);
    store.upsertSession("old-2", "proof", "proof/repo", workspace);
    store.upsertSession("current", "proof", "proof/repo", workspace);
    store.saveExperience({ id: "exp_login", repository_id: "proof/repo", source_session_id: "old-1", content: "Lesson: Login timeout tests require resetting the fake clock.", evidence: "{\"trace_ids\":[1]}" });
    store.saveExperience({ id: "exp_cache", repository_id: "proof/repo", source_session_id: "old-2", content: "Lesson: Cache writes must use an atomic rename.", evidence: "{\"trace_ids\":[2]}" });
    const selector = new FakeAgent('{"experience_ids":["exp_login"]}');
    const builder = new ContextBuilder(store, selector);

    const briefing = builder.buildProjectBriefing({ repoId: "proof/repo", sessionId: "current", workspaceRoot: workspace });
    expect(briefing).toContain("exp_login");
    expect(briefing).toContain("exp_cache");
    expect(briefing).toContain("Known commands: npm run test");
    const context = await builder.buildPromptContext({ repoId: "proof/repo", sessionId: "current", workspaceRoot: workspace, prompt: "Fix the login timeout test", projectBriefing: briefing });
    expect(selector.prompts[0]).toContain("exp_login");
    expect(selector.prompts[0]).toContain("exp_cache");
    expect(context).toContain("exp_login");
    expect(context).toContain("Supporting session evidence");
    expect(context).not.toContain("exp_cache");
    store.close();
  });

  it("falls back to local relevance when agent selection fails", async () => {
    const workspace = project();
    const store = new Store(openDatabase(":memory:"));
    store.upsertSession("source", "proof", "proof/repo", workspace);
    store.upsertSession("current", "proof", "proof/repo", workspace);
    store.saveExperience({ id: "exp_atomic", repository_id: "proof/repo", source_session_id: "source", content: "Lesson: Use atomic rename for cache writes.", evidence: null });
    const builder = new ContextBuilder(store, new ThrowingAgent());
    const context = await builder.buildPromptContext({ repoId: "proof/repo", sessionId: "current", workspaceRoot: workspace, prompt: "Make cache writes atomic" });
    expect(context).toContain("exp_atomic");
    store.close();
  });
});

class FakeAgent implements AgentClient {
  readonly prompts: string[] = [];
  constructor(private readonly response: string) {}
  async complete(prompt: string): Promise<string> { this.prompts.push(prompt); return this.response; }
}

class ThrowingAgent implements AgentClient {
  async complete(): Promise<string> { throw new Error("agent unavailable"); }
}

class SequenceAgent implements AgentClient {
  constructor(private readonly responses: string[]) {}
  async complete(): Promise<string> { return this.responses.shift() ?? "not json"; }
}

function project(): string {
  const workspace = mkdtempSync(join(tmpdir(), "termyte-experience-"));
  temporary.push(workspace);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "proof", description: "A proof repository", scripts: { test: "vitest" } }));
  writeFileSync(join(workspace, "README.md"), "# Proof\nA repository used to prove Termyte context.");
  return workspace;
}
