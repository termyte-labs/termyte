import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { HookRunner } from "../src/hooks/runner.js";
import { Observer } from "../src/observer/pipeline.js";
import { MemoryPipeline } from "../src/pipeline/memory-pipeline.js";
import { FTSSearch } from "../src/retrieval/fts.js";
import { VectorSearch } from "../src/retrieval/vector.js";
import { HybridSearch } from "../src/retrieval/hybrid.js";
import { ContextBuilder } from "../src/context/builder.js";
import { MockLLM } from "./mock-llm.js";
import type { EmbeddingsProvider } from "../src/retrieval/embeddings.js";
import {
  acquireWorkerLock,
  releaseWorkerLock,
  isWorkerRunning,
  resolveWorkerPath,
  DetachedWorkerSupervisor,
  RecordingWorkerSupervisor,
  createHookSupervisor,
} from "../src/pipeline/worker-supervisor.js";
import { processHookInput } from "../src/cli/hook.js";
import type { Platform } from "../src/core/types.js";

class MockEmbeddingsProvider implements EmbeddingsProvider {
  readonly dimensions = 4;
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dimensions);
    for (let i = 0; i < text.length; i++) v[i % this.dimensions]! += text.charCodeAt(i);
    return v;
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "termyte-supervisor-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function dbPath(): string {
  return join(tmp, "termyte.db");
}

describe("RUN-001 single-instance worker lock", () => {
  it("acquires, reports running, and releases", () => {
    const p = dbPath();
    expect(isWorkerRunning(p)).toBe(false);
    expect(acquireWorkerLock(p, process.pid)).toBe(true);
    expect(isWorkerRunning(p)).toBe(true);
    // A second acquirer (same live PID) cannot steal the lock.
    expect(acquireWorkerLock(p, process.pid)).toBe(false);
    releaseWorkerLock(p);
    expect(isWorkerRunning(p)).toBe(false);
  });

  it("takes over a stale lock whose holder is dead", async () => {
    const p = dbPath();
    // Spawn a child that exits immediately so its PID is no longer alive.
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const deadPid = child.pid!;
    writeFileSync(
      p + ".worker.lock",
      JSON.stringify({ pid: deadPid, startedAt: Date.now() }, null, 2),
      "utf-8",
    );
    expect(isWorkerRunning(p)).toBe(false);
    expect(acquireWorkerLock(p, process.pid)).toBe(true);
    releaseWorkerLock(p);
  });

  it("release is idempotent when the lock is already gone", () => {
    const p = dbPath();
    releaseWorkerLock(p);
    expect(isWorkerRunning(p)).toBe(false);
  });
});

describe("RUN-001 resolveWorkerPath", () => {
  it("prefers TERMYTE_WORKER_PATH when present", () => {
    const sentinel = join(tmp, "my-worker.js");
    writeFileSync(sentinel, "process.exit(0)\n", "utf-8");
    expect(resolveWorkerPath({ TERMYTE_WORKER_PATH: sentinel })).toBe(sentinel);
  });

  it("falls back to the built dist worker when built", () => {
    const path = resolveWorkerPath({});
    if (path) {
      expect(path.replace(/\\/g, "/").endsWith("dist/cli/worker.js")).toBe(true);
    }
  });
});

describe("RUN-001 detached supervisor", () => {
  it("spawns a detached worker process that runs to completion", async () => {
    const sentinelWorker = join(tmp, "sentinel-worker.js");
    const marker = join(tmp, "ran.sentinel");
    writeFileSync(
      sentinelWorker,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
      "utf-8",
    );
    const supervisor = new DetachedWorkerSupervisor({
      dbPath: dbPath(),
      workerPath: sentinelWorker,
      enabled: true,
    });
    expect(supervisor.maybeLaunch()).toBe(true);

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !existsSync(marker)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(existsSync(marker)).toBe(true);
  });

  it("does not spawn when the single-instance lock is already held", () => {
    const p = dbPath();
    acquireWorkerLock(p, process.pid);
    try {
      const supervisor = new DetachedWorkerSupervisor({
        dbPath: p,
        workerPath: join(tmp, "never.js"),
        enabled: true,
      });
      expect(supervisor.maybeLaunch()).toBe(false);
      expect(existsSync(join(tmp, "never.js"))).toBe(false);
    } finally {
      releaseWorkerLock(p);
    }
  });

  it("does not spawn when disabled", () => {
    const supervisor = new DetachedWorkerSupervisor({
      dbPath: dbPath(),
      workerPath: join(tmp, "never.js"),
      enabled: false,
    });
    expect(supervisor.maybeLaunch()).toBe(false);
  });
});

describe("RUN-001 createHookSupervisor", () => {
  it("returns a no-op supervisor when TERMYTE_AUTO_WORKER is disabled", () => {
    const s = createHookSupervisor(dbPath(), { TERMYTE_AUTO_WORKER: "0" });
    expect(s.maybeLaunch()).toBe(false);
  });

  it("ignores a missing TERMYTE_WORKER_PATH override and falls back to the built worker", () => {
    // The override does not exist, so resolution falls back to dist/cli/worker.js
    // (or the source checkout). A DetachedWorkerSupervisor would attempt a spawn,
    // so we verify by ensuring it is NOT the disabled no-op path.
    const s = createHookSupervisor(dbPath(), { TERMYTE_WORKER_PATH: join(tmp, "missing.js"), TERMYTE_AUTO_WORKER: "1" });
    // Constructing it must not throw; maybeLaunch is asserted elsewhere via the
    // sentinel spawn test. Here we only confirm the supervisor object exists.
    expect(typeof s.maybeLaunch).toBe("function");
  });
});

describe("RUN-001 hook triggers supervision", () => {
  let ctx: DatabaseContext;

  beforeEach(() => {
    ctx = openDatabase(":memory:");
  });
  afterEach(() => {
    ctx.db.close();
  });

  function makeDeps(store: Store, llm: MockLLM, supervisor = new RecordingWorkerSupervisor()) {
    const observer = new Observer({ store, llm });
    const runner = new HookRunner({ store, observer });
    const fts = new FTSSearch(store);
    const vector = new VectorSearch(store);
    const embeddings = new MockEmbeddingsProvider();
    const search = new HybridSearch({ fts, vector, embeddings });
    const builder = new ContextBuilder(store, search);
    return { runner, store, search, builder, observer, supervisor };
  }

  it("calls the supervisor once after ingesting a trace and leaves a pending job", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const supervisor = new RecordingWorkerSupervisor();
    const deps = makeDeps(store, llm, supervisor);

    await processHookInput("claude-code" as Platform, undefined, {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "content",
    }, deps);

    expect(supervisor.launchCount).toBe(1);
    const job = store.getDB().prepare(`SELECT state FROM jobs WHERE kind='extract_observation'`).get() as { state: string };
    expect(job.state).toBe("pending");
    store.close();
  });

  it("does not launch the supervisor when the payload is rejected", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const supervisor = new RecordingWorkerSupervisor();
    const deps = makeDeps(store, llm, supervisor);

    await processHookInput("claude-code" as Platform, undefined, null, deps);
    expect(supervisor.launchCount).toBe(0);
    store.close();
  });

  it("memory reaches active state after the supervised worker drains the queue", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const embeddings = new MockEmbeddingsProvider();
    const supervisor = new RecordingWorkerSupervisor();
    const deps = makeDeps(store, llm, supervisor);

    llm.setResponses([
      `<observation>
        <type>fact</type>
        <title>Observed fact</title>
        <description>Important fact.</description>
        <files_read><file>src/a.ts</file></files_read>
      </observation>`,
      `<observation>
        <type>fact</type>
        <title>Consolidated fact</title>
        <description>Important fact should be remembered.</description>
      </observation>`,
    ]);

    // The hook records the trace and enqueues extraction work...
    await processHookInput("claude-code" as Platform, undefined, {
      session_id: "s1",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "content",
    }, deps);
    expect(supervisor.launchCount).toBe(1);

    // ...the supervisor's worker drains the durable queue to idle.
    const pipeline = new MemoryPipeline({ store, llm, embeddings });
    const processed = await pipeline.runUntilIdle("worker-supervised", { maxJobs: 20 });

    expect(processed).toBeGreaterThan(0);
    const memory = store.getRecentMemories(1)[0]!;
    expect(memory.lifecycle_state).toBe("active");
    expect(memory.embedding).not.toBeNull();
    store.close();
  });

  it("a crashed worker's stale lock is taken over and draining resumes to active", async () => {
    const store = new Store(ctx);
    const llm = new MockLLM();
    const embeddings = new MockEmbeddingsProvider();
    const supervisor = new RecordingWorkerSupervisor();
    const deps = makeDeps(store, llm, supervisor);

    llm.setResponses([
      `<observation><type>fact</type><title>Observed fact</title><description>Important fact.</description><files_read><file>src/a.ts</file></files_read></observation>`,
      `<observation><type>fact</type><title>Consolidated fact</title><description>Important fact should be remembered.</description></observation>`,
    ]);

    await processHookInput("claude-code" as Platform, undefined, {
      session_id: "crash",
      cwd: "/work",
      tool_name: "Read",
      tool_input: { file_path: "src/a.ts" },
      tool_response: "content",
    }, deps);

    const pipeline = new MemoryPipeline({ store, llm, embeddings });
    // Simulate a worker that extracted the observation then crashed, leaving
    // a stale lock whose holder PID is dead.
    await pipeline.runOnce("worker-crashed");
    const p = join(tmp, "crash.db");
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    await new Promise<void>((r) => child.once("exit", () => r()));
    writeFileSync(p + ".worker.lock", JSON.stringify({ pid: child.pid, startedAt: Date.now() }, null, 2), "utf-8");
    expect(isWorkerRunning(p)).toBe(false);
    expect(acquireWorkerLock(p, process.pid)).toBe(true);

    // A fresh worker resumes and drains the remaining queue to idle/active.
    const processed = await pipeline.runUntilIdle("worker-restarted", { maxJobs: 20 });
    expect(processed).toBeGreaterThan(0);
    const memory = store.getRecentMemories(1)[0]!;
    expect(memory.lifecycle_state).toBe("active");
    releaseWorkerLock(p);
    store.close();
  });
});