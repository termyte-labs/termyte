import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runRuntimeProof } from "../src/proof.js";

describe("runtime proof", () => {
  it("proves allowed, blocked, side-effect, and ledger behavior", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "termyte-proof-"));
    const dbPath = path.join(cwd, "termyte.db");
    const report = await runRuntimeProof({ cwd, dbPath });

    expect(report.summary.fail).toBe(0);
    expect(report.checks.find((check) => check.id === "allowed.read")?.status).toBe("PASS");
    expect(report.checks.find((check) => check.id === "blocked.force_push")?.status).toBe("PASS");
    expect(report.checks.find((check) => check.id === "blocked.delete")?.status).toBe("PASS");
    expect(report.checks.find((check) => check.id === "side_effect.delete_prevented")?.status).toBe("PASS");
    expect(report.checks.find((check) => check.id === "ledger.records")?.status).toBe("PASS");
    expect(fs.existsSync(path.join(cwd, ".termyte", "runtime-proof", "keep.txt"))).toBe(true);
  }, 15000);
});
