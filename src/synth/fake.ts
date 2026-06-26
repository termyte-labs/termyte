/**
 * FakeAdapter — controllable mock for tests. Records every invocation
 * and returns the next canned response (or, by default, a `<skip_summary />`
 * XML block so the rest of the pipeline can run end-to-end).
 */
import type { AgentAdapter, AgentAdapterId, AgentInvokeOptions, AgentInvokeResult } from "./types.js";
import { AgentInvocationError } from "./types.js";

export class FakeAdapter implements AgentAdapter {
  readonly id: AgentAdapterId = "fake";
  readonly displayName = "fake";

  private responses: string[] = [];
  public calls: Array<{ prompt: string; opts: AgentInvokeOptions | undefined }> = [];
  public available = true;
  /** When set, the next call throws this. */
  public nextError: { reason: "not_available" | "timeout" | "cancelled" | "rate_limited" | "non_zero_exit" | "invalid_output" | "internal"; message: string } | null = null;

  setResponses(texts: string[]): void { this.responses = [...texts]; }
  setResponse(text: string): void { this.responses = [text]; }

  async isAvailable(): Promise<boolean> { return this.available; }

  async invoke(prompt: string, opts?: AgentInvokeOptions): Promise<AgentInvokeResult> {
    this.calls.push({ prompt, opts });
    if (this.nextError) {
      const e = this.nextError;
      this.nextError = null;
      throw new AgentInvocationError(e.reason, e.message);
    }
    const text = this.responses.shift() ?? "<skip_summary />";
    return { text, json: null, model: "fake", durationMs: 1 };
  }
}
