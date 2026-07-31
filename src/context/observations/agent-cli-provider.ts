import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "./provider.js";
import { createAdapter } from "../../agents/synthesis/index.js";
import type { AgentAdapterId } from "../../agents/synthesis/types.js";

/** Uses an already-authenticated coding-agent CLI for background synthesis. */
export class AgentCliLLMProvider implements LLMProvider {
  constructor(private readonly provider: Extract<AgentAdapterId, "claude-code" | "codex" | "opencode">) {}

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const adapter = createAdapter(this.provider);
    const prompt = messages.map((message) => `<${message.role}>\n${message.content}\n</${message.role}>`).join("\n\n");
    const result = await adapter.invoke(prompt, {
      timeoutMs: 5 * 60_000,
      signal: options?.signal,
      cwd: process.cwd(),
    });
    return {
      content: result.text,
      model: result.model ?? this.provider,
      usage: result.usage ? {
        inputTokens: result.usage.input ?? 0,
        outputTokens: result.usage.output ?? 0,
      } : undefined,
    };
  }
}

export class CaptureOnlyLLMProvider implements LLMProvider {
  async chat(): Promise<ChatResponse> {
    throw new Error("Synthesis is disabled; run termyte init to configure a provider");
  }
}
