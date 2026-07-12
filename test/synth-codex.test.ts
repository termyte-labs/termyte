/**
 * Integration test for the CodexAdapter. We point CODEX_PATH at a
 * tiny shell script that emits the documented JSONL event stream
 * (thread.started, turn.started, item.completed, turn.completed)
 * and the parser picks out the last agent_message.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInvocationError } from "../src/synth/types.js";

let fakeCodexPath: string;
let originalCodexPath: string | undefined;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "termyte-codex-"));
  // Emit a JSONL event stream. The last agent_message is the
  // synthesis result. The first line uses `printf` (no trailing
  // newline per call) so we can control the output exactly.
  const lines = [
    JSON.stringify({ type: "thread.started", thread_id: "0199a213-81c0-7800" }),
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({
      type: "item.completed",
      item: { id: "item_1", type: "agent_message", text: "<observation><type>fact</type><title>Project uses src/a.ts</title><description>Read of src/a.ts succeeded.</description><files_read><file>src/a.ts</file></files_read></observation>" },
    }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 123, output_tokens: 45 } }),
  ];
  if (process.platform === "win32") {
    fakeCodexPath = join(dir, "codex.cmd");
    const body = lines.map((l) => `echo ${l}`).join("\r\n");
    writeFileSync(fakeCodexPath, `@echo off\r\nif not "%TERMYTE_INTERNAL_SYNTHESIS%"=="1" exit /b 9\r\n${body}\r\n`, "utf-8");
  } else {
    fakeCodexPath = join(dir, "codex");
    const body = lines.map((l) => `printf '%s\\n' '${l}'`).join("\n");
    writeFileSync(fakeCodexPath,
      "#!/bin/sh\n" +
      "[ \"$TERMYTE_INTERNAL_SYNTHESIS\" = \"1\" ] || exit 9\n" +
      "cat >/dev/null\n" +
      `${body}\n`,
      "utf-8");
    try { require("node:fs").chmodSync(fakeCodexPath, 0o755); }
    catch { /* ignore on Windows */ }
  }
  originalCodexPath = process.env.CODEX_PATH;
  process.env.CODEX_PATH = fakeCodexPath;
});

afterEach(() => {
  if (originalCodexPath === undefined) delete process.env.CODEX_PATH;
  else process.env.CODEX_PATH = originalCodexPath;
  try { rmSync(join(fakeCodexPath, ".."), { recursive: true, force: true }); }
  catch { /* ignore */ }
});

describe("CodexAdapter", () => {
  it("isAvailable resolves to true when CODEX_PATH points to a file", async () => {
    const { CodexAdapter } = await import("../src/synth/codex.js");
    const a = new CodexAdapter();
    expect(await a.isAvailable()).toBe(true);
  });

  it("invoke parses the JSONL stream and returns the agent_message", async () => {
    const { CodexAdapter } = await import("../src/synth/codex.js");
    const a = new CodexAdapter();
    const result = await a.invoke("synthesize these", { timeoutMs: 10_000 });
    expect(result.text).toContain("<observation>");
    expect(result.text).toContain("src/a.ts");
    expect(result.usage?.input).toBe(123);
    expect(result.usage?.output).toBe(45);
  });

  it("invoke throws AgentInvocationError when no agent_message is emitted", async () => {
    const dir = join(fakeCodexPath, "..");
    if (process.platform === "win32") {
      writeFileSync(fakeCodexPath, "@echo off\r\necho {\"type\":\"thread.started\"}\r\necho {\"type\":\"turn.completed\"}\r\n", "utf-8");
    } else {
      writeFileSync(fakeCodexPath,
        "#!/bin/sh\n" +
        "cat >/dev/null\n" +
        "printf '%s\\n' '{\"type\":\"thread.started\"}'\n" +
        "printf '%s\\n' '{\"type\":\"turn.completed\"}'\n",
        "utf-8");
      try { require("node:fs").chmodSync(fakeCodexPath, 0o755); } catch { /* ignore */ }
    }
    const { CodexAdapter } = await import("../src/synth/codex.js");
    const a = new CodexAdapter();
    await expect(a.invoke("x", { timeoutMs: 10_000 })).rejects.toBeInstanceOf(AgentInvocationError);
    void dir;
  });

  it("invoke translates non-zero exit into AgentInvocationError", async () => {
    const dir = join(fakeCodexPath, "..");
    if (process.platform === "win32") {
      writeFileSync(fakeCodexPath, "@echo off\r\nexit /b 7\r\n", "utf-8");
    } else {
      writeFileSync(fakeCodexPath, "#!/bin/sh\nexit 7\n", "utf-8");
      try { require("node:fs").chmodSync(fakeCodexPath, 0o755); } catch { /* ignore */ }
    }
    const { CodexAdapter } = await import("../src/synth/codex.js");
    const a = new CodexAdapter();
    await expect(a.invoke("x", { timeoutMs: 10_000 }))
      .rejects.toThrow(/exited 7/);
    void dir;
  });

  it("invoke translates 'rate limit' stderr into rate_limited", async () => {
    const dir = join(fakeCodexPath, "..");
    if (process.platform === "win32") {
      writeFileSync(fakeCodexPath, "@echo off\r\necho rate limit reached 1>&2\r\nexit /b 1\r\n", "utf-8");
    } else {
      writeFileSync(fakeCodexPath, "#!/bin/sh\necho 'rate limit reached' 1>&2\nexit 1\n", "utf-8");
      try { require("node:fs").chmodSync(fakeCodexPath, 0o755); } catch { /* ignore */ }
    }
    const { CodexAdapter } = await import("../src/synth/codex.js");
    const a = new CodexAdapter();
    try {
      await a.invoke("x", { timeoutMs: 10_000 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentInvocationError);
      expect((err as AgentInvocationError).reason).toBe("rate_limited");
    }
    void dir;
  });
});
