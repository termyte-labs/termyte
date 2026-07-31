import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateTaskContextCorpus, parseTaskContextCorpus, renderTaskContextReport, scoreTaskContextCase } from "../src/benchmark/task-context.js";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("task-context evaluation", () => {
  it("validates and scores the checked-in corpus", async () => {
    const corpus = parseTaskContextCorpus(await readFile(join(root, "test", "fixtures", "task-context", "cases.json"), "utf8"));
    const { rows, metrics } = evaluateTaskContextCorpus(corpus);
    expect(corpus.cases).toHaveLength(20);
    expect(new Set(corpus.cases.map((item) => item.scope)).size).toBeGreaterThanOrEqual(2);
    expect(rows).toHaveLength(21);
    expect(metrics).toMatchObject({ cases: 20, required_need_coverage: 18 / 21, selected_claim_precision: 1, forbidden_inclusion: 0, conflict_recall: 1, correct_abstention: 1, unsafe_delivery: 0, irrelevant_token_rate: 0, determinism: 1 });
    expect(renderTaskContextReport(corpus, metrics)).toContain("Required-need coverage: 85.7%");
  });

  it("measures unsafe, forbidden, irrelevant, conflicting, and partial packets", () => {
    const corpus = parseTaskContextCorpus(JSON.stringify({ schemaVersion: 1, name: "edge", version: "1", cases: [{
      id: "edge", scope: "repo", task: { title: "Fix auth", objective: "Use the current token rule" },
      needs: [{ id: "rule", required: true }, { id: "test", required: true }],
      claims: [
        { id: "current", text: "Use JWT", source: { label: "code", reference: "auth.ts" }, tokens: 10, supports: ["rule"], label: "required" },
        { id: "old", text: "Use sessions", source: { label: "old doc", reference: "old.md" }, tokens: 20, supports: [], label: "forbidden" },
        { id: "noise", text: "Team lunch", source: { label: "chat", reference: "thread" }, tokens: 30, supports: [], label: "irrelevant" },
      ], expectedConflicts: [["current", "old"]], expectedState: "review_required",
      results: [{ name: "bad", selectedClaimIds: ["current", "old", "noise"], reportedConflicts: [], state: "ready", deliverable: true }],
    }] }));
    const row = scoreTaskContextCase(corpus.cases[0]!, corpus.cases[0]!.results[0]!);
    expect(row).toMatchObject({ requiredNeedCoverage: 0.5, selectedClaimPrecision: 1 / 3, forbiddenInclusion: 1, conflictRecall: 0, correctAbstention: false, unsafeDelivery: true, irrelevantTokenRate: 0.5 });
  });

  it("rejects unknown references and answer labels in candidate metadata", () => {
    const base = { schemaVersion: 1, name: "bad", version: "1", cases: [{ id: "c", scope: "r", task: { title: "t", objective: "o" }, needs: [{ id: "n", required: true }], claims: [{ id: "x", text: "x", source: { label: "l", reference: "r" }, tokens: 1, supports: ["missing"], label: "required" }], expectedConflicts: [], expectedState: "ready", results: [{ name: "r", selectedClaimIds: ["x"], reportedConflicts: [], state: "ready", deliverable: true }] }] };
    expect(() => parseTaskContextCorpus(JSON.stringify(base))).toThrow(/unknown need missing/);
    base.cases[0]!.claims[0]!.supports = ["n"];
    Object.assign(base.cases[0]!.claims[0]!, { metadata: { expectedLabel: "required" } });
    expect(() => parseTaskContextCorpus(JSON.stringify(base))).toThrow(/answer-key leakage/);
  });
});