import type { ChatMessage, ChatOptions, ChatResponse } from "../src/context/observations/provider.js";

/**
 * A controllable mock LLM for tests. Use `setResponse` to feed the next
 * canned reply, or `setResponses` to queue multiple.
 */
export class MockLLM {
  private queue: string[] = [];
  private responsesByTrace = new Map<string, string>();
  private throwByCall = new Map<number, Error>();
  public calls: ChatMessage[][] = [];
  public lastOptions?: ChatOptions;

  setResponse(text: string): void {
    this.queue = [text];
  }

  setResponses(texts: string[]): void {
    this.queue = [...texts];
  }

  setResponseForTrace(traceId: string | number, xml: string): void {
    this.responsesByTrace.set(String(traceId), xml);
  }

  setResponseSequence(texts: string[]): void {
    this.setResponses(texts);
  }

  throwOnCall(callNumber: number, error: Error): void {
    this.throwByCall.set(callNumber, error);
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    this.calls.push(messages);
    this.lastOptions = options;

    const callNumber = this.calls.length;
    const error = this.throwByCall.get(callNumber);
    if (error) {
      this.throwByCall.delete(callNumber);
      throw error;
    }

    const routed = this.responseForMessages(messages);
    if (routed !== undefined) {
      return { content: routed, model: "mock" };
    }

    const next = this.queue.shift();
    if (next === undefined) {
      // Use setImmediate to throw outside the current microtask, ensuring the
      // rejection is observable and doesn't get swallowed by unrelated chains.
      throw new Error(`MockLLM: no response queued (${this.calls.length} call(s) made, 0 remaining)`);
    }
    return { content: next, model: "mock" };
  }

  private responseForMessages(messages: ChatMessage[]): string | undefined {
    if (this.responsesByTrace.size === 0) return undefined;

    const joined = messages.map((message) => message.content).join("\n");
    for (const [traceId, response] of this.responsesByTrace) {
      if (joined.includes(traceId)) return response;
    }

    return undefined;
  }
}
