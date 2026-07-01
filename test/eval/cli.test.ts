import { describe, expect, it } from "vitest";
import { evalCommand, parseSuite, renderEvalReport } from "../../src/cli/eval.js";

describe("eval CLI helpers", () => {
  it("validates suite names", () => {
    expect(parseSuite(undefined)).toBe("all");
    expect(parseSuite("retrieval")).toBe("retrieval");
    expect(() => parseSuite("bad")).toThrow(/Invalid eval suite/);
  });

  it("renders human-readable reports", () => {
    const rendered = renderEvalReport({
      suite: "retrieval",
      passed: true,
      metrics: { recallAt5: 0.9, mrr: 0.78 },
      failures: [],
    });

    expect(rendered).toContain("Retrieval Eval");
    expect(rendered).toContain("PASS");
  });

  it("emits JSON-compatible report objects", async () => {
    const originalWrite = process.stdout.write;
    let output = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      const report = await evalCommand({ suite: "lifecycle", json: true });
      const parsed = JSON.parse(output) as { suite: string; passed: boolean };

      expect(report.passed).toBe(true);
      expect(parsed.suite).toBe("lifecycle");
      expect(parsed.passed).toBe(true);
    } finally {
      process.stdout.write = originalWrite;
    }
  });
});
