import { describe, it, expect } from "vitest";
import { buildBatchPrompt } from "../src/agents/synthesis/prompts.js";

describe("synth prompts", () => {
  it("buildBatchPrompt wraps every trace in a <trace> block", () => {
    const prompt = buildBatchPrompt([
      { id: 1, tool_name: "Read", tool_input: { file_path: "a.ts" }, tool_output: "x", user_prompt: null, timestamp: 1700000000000 },
    ]);
    expect(prompt).toContain("<trace>");
    expect(prompt).toContain("<id>1</id>");
    expect(prompt).toContain("<tool>Read</tool>");
  });

  it("buildBatchPrompt returns a skip-summary hint on empty input", () => {
    expect(buildBatchPrompt([])).toContain("<skip_summary />");
  });
});

describe("Adapter resolution", () => {
  it("createAdapter returns a FakeAdapter for the fake id", async () => {
    const { createAdapter } = await import("../src/agents/synthesis/index.js");
    const adapter = createAdapter("fake");
    expect(adapter.id).toBe("fake");
    expect(await adapter.isAvailable()).toBe(true);
  });
});
