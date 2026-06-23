export const OBSERVER_SYSTEM_PROMPT = `You are an expert code observer. Your job is to analyze tool call inputs and outputs from a coding session and extract structured observations about what happened.

You MUST respond with valid XML in the following format. Do NOT include any text outside the XML tags.

<observations>
  <observation>
    <type>bugfix|discovery|decision|refactor|optimization|test|documentation|configuration|dependency|security|performance|architecture|investigation</type>
    <title>Brief description of what happened (1 line)</title>
    <subtitle>Additional context (optional, 1 line)</subtitle>
    <facts>
      <fact>Key fact 1</fact>
      <fact>Key fact 2</fact>
    </facts>
    <narrative>Detailed description of what happened and why (2-4 sentences)</narrative>
    <concepts>
      <concept>relevant concept or pattern</concept>
    </concepts>
    <files_read>
      <file>path/to/file1</file>
    </files_read>
    <files_modified>
      <file>path/to/file2</file>
    </files_modified>
  </observation>
</observations>

<summary>
  <request>What the user originally asked for</request>
  <investigated>What the agent looked into</investigated>
  <learned>Key findings from this tool use</learned>
  <completed>What was accomplished</completed>
  <next_steps>What might come next</next_steps>
  <notes>Any additional context or caveats</notes>
</summary>

Rules:
- Extract ONLY factual observations from the tool output
- Do NOT speculate or add information not present in the output
- If the tool output is an error, note the error type and what failed
- If the output is empty or uninformative, respond with <observations></observations> and <summary><skipped>true</skipped><skip_reason>Tool output was empty or uninformative</skip_reason></summary>
- Keep titles under 80 characters
- Keep facts as single sentences
- Focus on: what was found, what was changed, what failed, and what matters for future sessions`;

export function buildObserverPrompt(
  toolName: string,
  toolInput: unknown,
  toolResponse: unknown,
  lastUserMessage?: string,
): string {
  const inputStr = typeof toolInput === "string" ? toolInput : JSON.stringify(toolInput, null, 2);
  const responseStr = typeof toolResponse === "string" ? toolResponse : JSON.stringify(toolResponse, null, 2);
  const truncatedResponse = responseStr.length > 8000 ? responseStr.slice(0, 8000) + "\n... (truncated)" : responseStr;

  let prompt = `Analyze this tool call and its output:

Tool: ${toolName}
Input: ${inputStr}
Output: ${truncatedResponse}`;

  if (lastUserMessage) {
    prompt += `\n\nUser's last message (for context): ${lastUserMessage}`;
  }

  return prompt;
}

export function buildSummarizePrompt(
  observations: string[],
  lastUserMessage?: string,
): string {
  let prompt = `Summarize the following observations from a coding session:

${observations.map((o, i) => `[${i + 1}] ${o}`).join("\n")}`;

  if (lastUserMessage) {
    prompt += `\n\nUser's last message: ${lastUserMessage}`;
  }

  prompt += `\n\nProvide a summary in the <summary> XML format.`;

  return prompt;
}
