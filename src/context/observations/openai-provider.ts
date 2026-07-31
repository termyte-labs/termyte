import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from "./provider.js";

export interface OpenAIProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  defaultTemperature?: number;
  defaultMaxTokens?: number;
}

/**
 * OpenAI-compatible chat completion provider. Works against OpenAI, Ollama,
 * LM Studio, vLLM, and any other endpoint that speaks the /v1/chat/completions
 * shape.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private config: OpenAIProviderConfig) {}

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.config.apiKey ? { "Authorization": `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options?.model ?? this.config.model,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        temperature: options?.temperature ?? this.config.defaultTemperature ?? 0.3,
        max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens ?? 4096,
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed: ${response.status} ${response.statusText} ${text}`);
    }

    const data = (await response.json()) as any;
    const content: string = data.choices?.[0]?.message?.content ?? "";
    const model: string = data.model ?? this.config.model;
    const usage = data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
        }
      : undefined;

    return { content, model, usage };
  }
}
