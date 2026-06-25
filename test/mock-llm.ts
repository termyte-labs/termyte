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
      throw new Error("MockLLM: no response queued");
    }
    return { content: next, model: "mock" };
  }
}
