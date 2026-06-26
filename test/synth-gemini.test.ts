/**
 * Integration test for the GeminiCliAdapter. The fake `gemini` binary
 * echoes a canned JSON envelope; we also exercise the rate limiter.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInvocationError } from "../src/synth/types.js";

let fakeGeminiPath: string;
let originalGeminiPath: string | undefined;
let originalRpm: string | undefined;
let originalRpd: string | undefined;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "termyte-gemini-"));
  const envelope = JSON.stringify({
    response: "<skip_summary />",
    stats: { input_tokens: 11, output_tokens: 22, model: "gemini-2.0-flash" },
  });
  if (process.platform === "win32") {
    fakeGeminiPath = join(dir, "gemini.cmd");
    writeFileSync(fakeGeminiPath, `@echo off\r\necho ${envelope}\r\n`, "utf-8");
  } else {
    fakeGeminiPath = join(dir, "gemini");
    writeFileSync(fakeGeminiPath,
      "#!/bin/sh\n" +
      `printf '%s' '${envelope}'\n`,
      "utf-8");
    try { require("node:fs").chmodSync(fakeGeminiPath, 0o755); }
    catch { /* ignore */ }
  }
  originalGeminiPath = process.env.GEMINI_PATH;
  process.env.GEMINI_PATH = fakeGeminiPath;
  // Lift the per-test default limits so we can run more than the
  // production defaults would allow.
  originalRpm = process.env.TERMYTE_GEMINI_RPM;
  originalRpd = process.env.TERMYTE_GEMINI_RPD;
  process.env.TERMYTE_GEMINI_RPM = "1000";
  process.env.TERMYTE_GEMINI_RPD = "10000";
});

afterEach(() => {
  if (originalGeminiPath === undefined) delete process.env.GEMINI_PATH;
  else process.env.GEMINI_PATH = originalGeminiPath;
  if (originalRpm === undefined) delete process.env.TERMYTE_GEMINI_RPM;
  else process.env.TERMYTE_GEMINI_RPM = originalRpm;
  if (originalRpd === undefined) delete process.env.TERMYTE_GEMINI_RPD;
  else process.env.TERMYTE_GEMINI_RPD = originalRpd;
  try { rmSync(join(fakeGeminiPath, ".."), { recursive: true, force: true }); }
  catch { /* ignore */ }
});

describe("GeminiCliAdapter", () => {
  it("isAvailable resolves to true when GEMINI_PATH points to a file", async () => {
    const { GeminiCliAdapter } = await import("../src/synth/gemini-cli.js");
    const a = new GeminiCliAdapter();
    expect(await a.isAvailable()).toBe(true);
  });

  it("invoke parses the JSON envelope", async () => {
    const { GeminiCliAdapter } = await import("../src/synth/gemini-cli.js");
    const a = new GeminiCliAdapter();
    const result = await a.invoke("synthesize", { timeoutMs: 10_000 });
    expect(result.text).toBe("<skip_summary />");
    expect(result.model).toBe("gemini-2.0-flash");
    expect(result.usage?.input).toBe(11);
    expect(result.usage?.output).toBe(22);
  });

  it("invoke throws rate_limited when the limiter is exhausted", async () => {
    const { GeminiCliAdapter } = await import("../src/synth/gemini-cli.js");
    const a = new GeminiCliAdapter();
    // Override the production default (50/min) with 2/min so the
    // third call exceeds the budget.
    a.__setRateLimits(2, 10_000);
    await a.invoke("a", { timeoutMs: 10_000 });
    await a.invoke("b", { timeoutMs: 10_000 });
    try {
      await a.invoke("c", { timeoutMs: 10_000 });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentInvocationError);
      expect((err as AgentInvocationError).reason).toBe("rate_limited");
    }
  });

  it("invoke translates 'rate limit' stderr into rate_limited", async () => {
    const dir = join(fakeGeminiPath, "..");
    if (process.platform === "win32") {
      writeFileSync(fakeGeminiPath, "@echo off\r\necho rate limit reached 1>&2\r\nexit /b 1\r\n", "utf-8");
    } else {
      writeFileSync(fakeGeminiPath, "#!/bin/sh\necho 'rate limit reached' 1>&2\nexit 1\n", "utf-8");
      try { require("node:fs").chmodSync(fakeGeminiPath, 0o755); } catch { /* ignore */ }
    }
    const { GeminiCliAdapter } = await import("../src/synth/gemini-cli.js");
    const a = new GeminiCliAdapter();
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
