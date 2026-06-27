import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Spend module tests. The module reads from a hard-coded path
 * (`$TERMYTE_HOME/.termyte/spend.json`). We set TERMYTE_HOME to a
 * temp directory so the module writes there.
 */
describe("Spend", () => {
  let home: string;
  let originalTermyteHome: string | undefined;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "termyte-spend-"));
    originalTermyteHome = process.env.TERMYTE_HOME;
    process.env.TERMYTE_HOME = home;
    // Reset the module's path cache so the new TERMYTE_HOME is honored.
    const { _resetPathForTest } = await import("../src/synth/spend.js");
    _resetPathForTest();
  });

  afterEach(async () => {
    if (originalTermyteHome === undefined) delete process.env.TERMYTE_HOME;
    else process.env.TERMYTE_HOME = originalTermyteHome;
    const { _resetPathForTest } = await import("../src/synth/spend.js");
    _resetPathForTest();
    rmSync(home, { recursive: true, force: true });
  });

  function spendPath(): string {
    return join(home, ".termyte", "spend.json");
  }

  it("starts with an empty file path that does not exist", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    expect(Spend.today()).toBeNull();
  });

  it("records an invocation and returns today's totals", async () => {
    const { Spend, _resetPathForTest } = await import("../src/synth/spend.js");
    _resetPathForTest();
    const result = Spend.record({ input: 100, output: 50, estCostUsd: 0.01 });
    expect(result.allowed).toBe(true);
    expect(result.spend.invocations).toBe(1);
    expect(result.spend.input_tokens).toBe(100);
    expect(result.spend.output_tokens).toBe(50);
    expect(result.spend.est_cost_usd).toBeCloseTo(0.01, 5);
    // Force a re-read with the current TERMYTE_HOME.
    _resetPathForTest();
    expect(Spend.today()?.invocations).toBe(1);
  });

  it("denies the next invocation when the daily cap is reached", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    Spend.record({}, { maxInvocationsPerDay: 2 });
    Spend.record({}, { maxInvocationsPerDay: 2 });
    const third = Spend.record({}, { maxInvocationsPerDay: 2 });
    expect(third.allowed).toBe(false);
    expect(third.spend.invocations).toBe(2);
  });

  it("denies when the cost cap is reached", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    Spend.record({ estCostUsd: 0.30 }, { maxCostPerDayUsd: 0.50 });
    const next = Spend.record({ estCostUsd: 0.30 }, { maxCostPerDayUsd: 0.50 });
    expect(next.allowed).toBe(false);
  });

  it("writes the file with a checksum", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    Spend.record({ input: 10, output: 5 });
    const path = spendPath();
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.checksum).toBeTruthy();
    expect(parsed.checksum.length).toBe(64);
  });

  it("detects a corrupted file and reports no data", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    // mkdirSync equivalent for the test (we don't have access to
    // spendPath's internal mkdir).
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(home, ".termyte"), { recursive: true });
    writeFileSync(spendPath(), JSON.stringify({
      checksum: "0".repeat(64),
      days: { [new Date().toISOString().slice(0, 10)]: { invocations: 1, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 } },
    }), "utf-8");
    expect(Spend.today()).toBeNull();
  });

  it("atomic rename — concurrent writers don't corrupt the file", async () => {
    const { Spend } = await import("../src/synth/spend.js");
    // Fire 10 concurrent records.
    await Promise.all(Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => Spend.record({ input: 1 })),
    ));
    const today = Spend.today();
    expect(today?.invocations).toBe(10);
    expect(today?.input_tokens).toBe(10);
  });
});
