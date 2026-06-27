/**
 * Stress test for the OpenCode plugin's stdio race.
 *
 * The previous implementation called child.stdin.write() immediately
 * after spawn(), which on Windows races the OS's pipe setup and
 * loses the payload. The fix writes only on the 'open' event.
 *
 * We can't easily simulate the race here (it depends on the OS), so
 * we instead verify the *shape* of the fix: the plugin defers the
 * write until the 'open' event fires. We do this by reading the
 * source and asserting the 'open' handler is present.
 *
 * For real end-to-end coverage of the stdio race, run the plugin
 * against an actual OpenCode install on Windows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_PATH = join(process.cwd(), "src", "integrations", "opencode-plugin", "index.ts");

describe("OpenCode plugin stdio safety", () => {
  it("waits for stdin 'open' before writing the payload", () => {
    const src = readFileSync(PLUGIN_PATH, "utf-8");
    // The fix: child.stdin.on("open", () => { ... write ... })
    // The bug: child.stdin.write(...) immediately after spawn()
    expect(src).toMatch(/child\.stdin\.on\(\s*['"]open['"]/);
    expect(src).toMatch(/child\.stdin!\.write\(\s*JSON\.stringify/);
  });

  it("drains stderr so the child never blocks on a full pipe buffer", () => {
    const src = readFileSync(PLUGIN_PATH, "utf-8");
    expect(src).toMatch(/child\.stderr\?\.on\(\s*['"]data['"]/);
  });

  it("unrefs the child so the host process can exit independently", () => {
    const src = readFileSync(PLUGIN_PATH, "utf-8");
    expect(src).toMatch(/child\.unref\(\)/);
  });

  it("handles child.stdin errors without crashing the host", () => {
    const src = readFileSync(PLUGIN_PATH, "utf-8");
    expect(src).toMatch(/child\.stdin\.on\(\s*['"]error['"]/);
  });
});
