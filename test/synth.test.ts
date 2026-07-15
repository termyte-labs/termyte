import { describe, it, expect } from "vitest";
import { buildBatchPrompt } from "../src/synth/prompts.js";
import { Lock } from "../src/synth/lock.js";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("synth prompts", () => {
  it("buildBatchPrompt wraps every trace in a <trace> block", () => {
    const prompt = buildBatchPrompt([
      { id: 1, tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "x", user_prompt: null, timestamp: 1700000000000 },
    ]);
    expect(prompt).toContain("<trace>");
    expect(prompt).toContain("<id>1</id>");
    expect(prompt).toContain("<tool>Read</tool>");
  });

  it("buildBatchPrompt returns a skip-summary hint on empty input", () => {
    expect(buildBatchPrompt([])).toContain("<skip_summary />");
  });
});

describe("Lock", () => {
  it("acquires and releases a lock file", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      const lock = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      expect(existsSync(path)).toBe(true);
      lock.release();
      expect(existsSync(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-acquires a stale lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      writeFileSync(path, JSON.stringify({ pid: 999999, startedAt: 0, host: "dead" }));
      const lock = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      expect(readFileSync(path, "utf-8")).toContain(`"pid":${process.pid}`);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a live lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "termyte-lock-"));
    try {
      const path = join(dir, "synth.lock");
      const lock = Lock.acquire(path, { pid: process.pid, startedAt: Date.now(), host: "test" });
      try {
        expect(() => Lock.acquire(path, { pid: process.pid, startedAt: Date.now() + 1, host: "x" }))
          .toThrow(/already running/);
      } finally {
        lock.release();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Adapter resolution", () => {
  it("createAdapter returns a FakeAdapter for the fake id", async () => {
    const { createAdapter } = await import("../src/synth/index.js");
    const adapter = createAdapter("fake");
    expect(adapter.id).toBe("fake");
    expect(await adapter.isAvailable()).toBe(true);
  });
});
