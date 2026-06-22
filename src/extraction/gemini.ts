import { GoogleGenAI, Type } from "@google/genai";

export interface GeminiClient {
  extractMemories(trace: string, repoScope: string): Promise<ExtractedMemoryResult[]>;
  embedText(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  consolidateMemories(claims: string[]): Promise<ConsolidatedMemoryResult>;
}

export interface ExtractedMemoryResult {
  claim: string;
  type: "fact" | "bugfix" | "procedure" | "convention" | "warning";
  language?: string;
}

export interface ConsolidatedMemoryResult {
  claim: string;
  type: "fact" | "bugfix" | "procedure" | "convention" | "warning";
  sourceIndices: number[];
}

const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    memories: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING },
          type: {
            type: Type.STRING,
            enum: ["fact", "bugfix", "procedure", "convention", "warning"],
          },
          language: { type: Type.STRING },
        },
        propertyOrdering: ["claim", "type", "language"],
        required: ["claim", "type"],
      },
    },
  },
  propertyOrdering: ["memories"],
  required: ["memories"],
};

const CONSOLIDATION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    consolidated: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING },
          type: {
            type: Type.STRING,
            enum: ["fact", "bugfix", "procedure", "convention", "warning"],
          },
          sourceIndices: {
            type: Type.ARRAY,
            items: { type: Type.NUMBER },
          },
        },
        propertyOrdering: ["claim", "type", "sourceIndices"],
        required: ["claim", "type", "sourceIndices"],
      },
    },
  },
  propertyOrdering: ["consolidated"],
  required: ["consolidated"],
};

export function createGeminiClient(apiKey: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });

  async function extractMemories(
    trace: string,
    repoScope: string,
  ): Promise<ExtractedMemoryResult[]> {
    const prompt = `You are analyzing a coding agent session trace to extract reusable memories.

A "memory" is a durable fact, bugfix pattern, procedure, convention, or warning that would help a coding agent in future sessions.

Repository: ${repoScope}

Session trace:
${trace}

Extract ALL applicable memories from this trace. For each memory:
- claim: A clear, self-contained description of the fact/fix/procedure/convention/warning
- type: One of "fact", "bugfix", "procedure", "convention", "warning"
- language: The programming language if applicable (e.g. "typescript", "python")

Focus on:
1. Bug fixes: What went wrong and how it was fixed
2. Facts about the codebase: Architecture, conventions, dependencies
3. Procedures: Multi-step workflows that succeeded
4. Warnings: Patterns that caused problems
5. Conventions: Coding style, naming patterns, project structure

Do NOT include:
- One-off temporary actions with no reusable value
- Trivial observations (e.g. "user typed a command")
- Anything that would become stale quickly

Return structured JSON memories.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: EXTRACTION_SCHEMA,
      },
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(text) as { memories: ExtractedMemoryResult[] };
    return parsed.memories ?? [];
  }

  async function embedText(text: string): Promise<number[]> {
    const response = await ai.models.embedContent({
      model: "gemini-embedding-2",
      contents: text,
      config: {
        outputDimensionality: 768,
      },
    });
    const embedding = response.embeddings?.[0];
    if (!embedding?.values) throw new Error("No embedding returned");
    return Array.from(embedding.values);
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const results: number[][] = [];
    const batchSize = 20;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await ai.models.embedContent({
        model: "gemini-embedding-2",
        contents: batch,
        config: {
          outputDimensionality: 768,
        },
      });
      for (const emb of response.embeddings ?? []) {
        results.push(emb.values ? Array.from(emb.values) : new Array(768).fill(0));
      }
    }
    return results;
  }

  async function consolidateMemories(
    claims: string[],
  ): Promise<ConsolidatedMemoryResult> {
    const prompt = `You are consolidating similar coding memories into higher-level patterns.

Given these memory claims:
${claims.map((c, i) => `[${i}] ${c}`).join("\n")}

Identify groups of memories that describe the same underlying concept or pattern. For each group, create a single consolidated memory that captures the general principle.

Only consolidate if memories are genuinely related. If a memory is unique, keep it separate.

Return a consolidation result with the merged claims and which original indices they cover.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: CONSOLIDATION_SCHEMA,
      },
    });

    const text = response.text ?? "";
    const parsed = JSON.parse(text) as { consolidated: ConsolidatedMemoryResult[] };
    // Return the first consolidation (or a passthrough if none)
    return parsed.consolidated?.[0] ?? {
      claim: claims[0] ?? "",
      type: "fact",
      sourceIndices: claims.map((_, i) => i),
    };
  }

  return { extractMemories, embedText, embedBatch, consolidateMemories };
}
