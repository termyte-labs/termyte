import type { ChatMessage, ChatOptions, ChatResponse } from "../src/observer/provider.js";

/**
 * A controllable mock LLM for tests. Use `setResponse` to feed the next
 * canned reply, or `setResponses` to queue multiple.
 */
export class MockLLM {
  private queue: string[] = [];
  public calls: ChatMessage[][] = [];
  public lastOptions?: ChatOptions;

  setResponse(text: string): void {
    this.queue = [text];
  }

  setResponses(texts: string[]): void {
    this.queue = [...texts];
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    this.calls.push(messages);
    this.lastOptions = options;
    const next = this.queue.shift();
    if (next === undefined) {
      // Use setImmediate to throw outside the current microtask, ensuring the
      // rejection is observable and doesn't get swallowed by unrelated chains.
      throw new Error(`MockLLM: no response queued (${this.calls.length} call(s) made, 0 remaining)`);
    }
    return { content: next, model: "mock" };
  }
}
