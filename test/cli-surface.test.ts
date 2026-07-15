import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "dist", "cli", "index.js");

beforeAll(() => {
  const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.json")], {
    cwd: root, encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}, 30_000);

describe("public CLI surface", () => {
  it("advertises exactly five commands", () => {
    const result = spawnSync(process.execPath, [cli, "help"], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0);
    const commands = result.stdout.split(/\r?\n/)
      .map((line) => line.match(/^  (init|viewer|doctor|uninstall|help)\b/)?.[1])
      .filter(Boolean);
    expect(commands).toEqual(["init", "viewer", "doctor", "uninstall", "help"]);
    expect(result.stdout).not.toMatch(/^  (capture|remember|inspect|evaluate|search|context|eval|bench|mcp)\b/m);
  });

  it.each(["capture", "remember", "inspect", "evaluate", "search", "context", "eval", "bench", "mcp"])(
    "rejects former command %s with a Viewer direction",
    (command) => {
      const result = spawnSync(process.execPath, [cli, command], { cwd: root, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("termyte viewer");
    },
  );
});
