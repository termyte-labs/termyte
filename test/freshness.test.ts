import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkFreshness } from "../src/context/freshness.js";

describe("context freshness", () => {
  it("marks missing references stale", () => {
    const root = mkdtempSync(join(tmpdir(), "termyte-freshness-"));
    try {
      writeFileSync(join(root, "present.txt"), "ok");
      expect(checkFreshness(root, ["missing.txt"]).state).toBe("stale");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not claim freshness when Git cannot verify the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "termyte-freshness-"));
    try {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src", "app.ts"), "export {};");
      expect(checkFreshness(root, ["src/app.ts"]).state).toBe("unverifiable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
