import { describe, it, expect, vi } from "vitest";
import type { ChatMessage, ChatResponse } from "../src/context/observations/provider.js";

const STRICTER_MARKER = "Your previous response was invalid";

describe("chatWithRetry", () => {
  it("returns the first response when valid", async () => {
    const { chatWithRetry } = await import("../src/context/observations/self-correct.js");

    const mockProvider = {
      async chat(): Promise<ChatResponse> {
        return { content: "<observation><type>fact</type><title>OK</title><description>desc</description></observation>", model: "test" };
      },
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ];

    const result = await chatWithRetry(
      mockProvider,
      messages,
      undefined,
      (c) => c.includes("<observation"),
    );

    expect(result.content).toContain("fact");
  });

  it("retries with a stricter prompt when first response is invalid", async () => {
    const { chatWithRetry } = await import("../src/context/observations/self-correct.js");

    let callCount = 0;
    const mockProvider = {
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) {
          return { content: "garbage", model: "test" };
        }
        return { content: "<observation><type>fact</type><title>Good</title><description>y</description></observation>", model: "test" };
      },
    };

    // Capture the messages sent on the second call
    let secondCallMessages: ChatMessage[] | null = null;
    const spyProvider = {
      async chat(messages: ChatMessage[]): Promise<ChatResponse> {
        const result = await mockProvider.chat(messages);
        if (callCount === 2) secondCallMessages = messages;
        return result;
      },
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ];

    const result = await chatWithRetry(
      spyProvider,
      messages,
      undefined,
      (c) => c.includes("<observation"),
    );

    expect(callCount).toBe(2);
    expect(result.content).toContain("Good");
    expect(secondCallMessages).not.toBeNull();
    expect(secondCallMessages![1].content).toContain(STRICTER_MARKER);
  });

  it("returns the first (invalid) response when retry LLM call throws", async () => {
    const { chatWithRetry } = await import("../src/context/observations/self-correct.js");

    let callCount = 0;
    const mockProvider = {
      async chat(): Promise<ChatResponse> {
        callCount++;
        if (callCount === 1) {
          return { content: "still invalid", model: "test" };
        }
        throw new Error("no response queued");
      },
    };

    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ];

    const result = await chatWithRetry(
      mockProvider as any,
      messages,
      undefined,
      () => false,
    );

    expect(callCount).toBe(2);
    expect(result.content).toBe("still invalid");
  });
});

describe("schemas", () => {
  it("validates a valid observation", async () => {
    const { validateObservation } = await import("../src/context/observations/schemas.js");
    expect(validateObservation({
      type: "bugfix",
      title: "Fixed login bug",
      description: "The login form was broken",
    })).toBe(true);
  });

  it("rejects an observation with invalid type", async () => {
    const { validateObservation } = await import("../src/context/observations/schemas.js");
    expect(validateObservation({
      type: "knowledge",
      title: "Some title",
      description: "desc",
    })).toBe(false);
  });

  it("rejects an observation with empty title", async () => {
    const { validateObservation } = await import("../src/context/observations/schemas.js");
    expect(validateObservation({
      type: "fact",
      title: "",
      description: "desc",
    })).toBe(false);
  });

  it("validates a valid summary", async () => {
    const { validateSummary } = await import("../src/context/observations/schemas.js");
    expect(validateSummary({
      summary_text: "Session went well",
      key_changes: ["fixed bug"],
      key_learnings: ["learned about X"],
    })).toBe(true);
  });

  it("rejects a summary with empty text", async () => {
    const { validateSummary } = await import("../src/context/observations/schemas.js");
    expect(validateSummary({
      summary_text: "",
    })).toBe(false);
  });
});
