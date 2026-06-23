import type { GeminiClient, ExtractedMemoryResult, ConsolidatedMemoryResult } from "../src/extraction/gemini.js";

export interface FakeGeminiOptions {
  observationsXml?: string;
  extractedMemories?: ExtractedMemoryResult[];
  embeddings?: number[][];
  summaries?: string[];
}

const DEFAULT_OBSERVATION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<observations>
  <observation>
    <type>discovery</type>
    <title>Read source file</title>
    <subtitle>Inspected authentication module</subtitle>
    <facts>
      <fact>The authenticate function checks a token against a hardcoded value.</fact>
    </facts>
    <narrative>The agent read the auth module and noted that authentication is a simple equality check.</narrative>
    <concepts>
      <concept>authentication</concept>
    </concepts>
    <files_read>
      <file>src/auth.ts</file>
    </files_read>
    <files_modified></files_modified>
  </observation>
</observations>
<summary>
  <request>Read auth module</request>
  <learned>Auth is a hardcoded equality check</learned>
</summary>`;

const DEFAULT_MEMORIES: ExtractedMemoryResult[] = [
  {
    claim: "Auth uses a hardcoded token equality check; rotating the token requires updating the source.",
    type: "warning",
    language: "typescript",
  },
  {
    claim: "Always read the auth module before making auth-related changes in this repo.",
    type: "procedure",
    language: "typescript",
  },
];

export function createFakeGemini(options: FakeGeminiOptions = {}): GeminiClient & {
  observeToolUseCalls: Array<{ toolName: string; toolInput: unknown; toolResponse: unknown; lastUserMessage?: string }>;
  embedTextCalls: string[];
  extractMemoriesCalls: Array<{ trace: string; repoScope: string }>;
} {
  const observeToolUseCalls: Array<{ toolName: string; toolInput: unknown; toolResponse: unknown; lastUserMessage?: string }> = [];
  const embedTextCalls: string[] = [];
  const extractMemoriesCalls: Array<{ trace: string; repoScope: string }> = [];

  const observationXml = options.observationsXml ?? DEFAULT_OBSERVATION_XML;
  const extractedMemories = options.extractedMemories ?? DEFAULT_MEMORIES;
  const embeddings = options.embeddings ?? [];

  let embedIndex = 0;
  let summaryIndex = 0;
  const summaries = options.summaries ?? [];

  return {
    observeToolUseCalls,
    embedTextCalls,
    extractMemoriesCalls,

    async observeToolUse(toolName, toolInput, toolResponse, lastUserMessage) {
      observeToolUseCalls.push({ toolName, toolInput, toolResponse, lastUserMessage });
      return observationXml;
    },

    async extractMemories(trace, repoScope) {
      extractMemoriesCalls.push({ trace, repoScope });
      return extractedMemories;
    },

    async embedText(text) {
      embedTextCalls.push(text);
      if (embeddings.length > 0) {
        const v = embeddings[embedIndex % embeddings.length];
        embedIndex++;
        return v;
      }
      const v = new Array(768).fill(0);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      for (let i = 0; i < 768; i++) {
        v[i] = Math.sin(h + i) * 0.01;
      }
      return v;
    },

    async embedBatch(texts) {
      const out: number[][] = [];
      for (const t of texts) out.push(await this.embedText(t));
      return out;
    },

    async consolidateMemories(claims): Promise<ConsolidatedMemoryResult> {
      return {
        claim: claims[0] ?? "",
        type: "fact",
        sourceIndices: claims.map((_, i) => i),
      };
    },

    async generateContent(_prompt) {
      const s = summaries[summaryIndex % summaries.length] ?? "summary";
      summaryIndex++;
      return s;
    },
  };
}
