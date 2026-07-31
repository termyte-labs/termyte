/**
 * Self-correction: retry an LLM call with a stricter prompt suffix
 * when the first output fails validation.
 *
 * Adapted from agentmemory's src/eval/self-correct.ts.
 */

import type { LLMProvider, ChatMessage, ChatOptions, ChatResponse } from "./provider.js";

const STRICTER_SUFFIX =
  "\n\nYour previous response was invalid. Output ONLY valid XML matching the schema. No prose, no markdown, no explanations.";

export async function chatWithRetry(
  llm: LLMProvider,
  messages: ChatMessage[],
  options: ChatOptions | undefined,
  validate: (content: string) => boolean,
): Promise<ChatResponse> {
  const first = await llm.chat(messages, options);
  if (validate(first.content)) return first;

  try {
    const stricter: ChatMessage[] = [...messages];
    stricter[stricter.length - 1] = {
      ...stricter[stricter.length - 1],
      content: stricter[stricter.length - 1].content + STRICTER_SUFFIX,
    };
    const second = await llm.chat(stricter, options);
    return second;
  } catch {
    return first;
  }
}
