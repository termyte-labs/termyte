import { describe, it, expect, vi } from "vitest";
import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "../src/observer/provider.js";
import { CircuitBreaker } from "../src/observer/circuit-breaker.js";
import { ResilientProvider, FallbackChainProvider, createResilientFallbackChain } from "../src/observer/fallback-chain.js";

function makeProvider(resp: ChatResponse | Error, model = "test-model"): LLMProvider {
  return {
    async chat(
      _messages: ChatMessage[],
      _options?: ChatOptions,
    ): Promise<ChatResponse> {
      if (resp instanceof Error) throw resp;
      return resp;
    },
  };
}

const ok: ChatResponse = { content: "<ok/>", model: "test-model" };

describe("CircuitBreaker", () => {
  it("opens after the threshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });
    expect(cb.currentState).toBe("closed");
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    expect(cb.currentState).toBe("open");
    await expect(cb.exec(async () => 1)).rejects.toThrow("Circuit breaker is open");
  });

  it("probes half-open after timeout then closes on success", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30 });
    await expect(cb.exec(async () => { throw new Error("fail"); })).rejects.toThrow("fail");
    expect(cb.currentState).toBe("open");
    await new Promise((r) => setTimeout(r, 40));
    const spy = vi.fn(async () => 42);
    const result = await cb.exec(spy);
    expect(result).toBe(42);
    expect(cb.currentState).toBe("closed");
  });
});

describe("ResilientProvider", () => {
  it("passes through on success", async () => {
    const provider = new ResilientProvider(makeProvider(ok));
    const result = await provider.chat([]);
    expect(result.content).toBe("<ok/>");
  });
});

describe("FallbackChainProvider", () => {
  it("falls through to the second provider on failure", async () => {
    const failing = makeProvider(new Error("boom"));
    const good = makeProvider(ok);
    const chain = new FallbackChainProvider([failing, good]);
    const result = await chain.chat([]);
    expect(result.content).toBe("<ok/>");
  });

  it("throws when all providers fail", async () => {
    const chain = new FallbackChainProvider([
      makeProvider(new Error("a fail")),
      makeProvider(new Error("b fail")),
    ]);
    await expect(chain.chat([])).rejects.toThrow("b fail");
  });
});

describe("createResilientFallbackChain", () => {
  it("wraps providers in resilient + chain", async () => {
    const chain = createResilientFallbackChain([makeProvider(ok)]);
    const result = await chain.chat([]);
    expect(result.content).toBe("<ok/>");
  });
});