import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join, sep, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
  main?: string;
};
const tsconfig = JSON.parse(
  readFileSync(join(root, "tsconfig.json"), "utf8").replace(/\/\*.*?\*\//g, "").replace(/\/\/.*/g, ""),
) as { compilerOptions?: { rootDir?: string; outDir?: string } };

const rootDir = tsconfig.compilerOptions?.rootDir;
const outDir = tsconfig.compilerOptions?.outDir ?? "dist";

/** Convert a `package.json` dist path (`dist/cli/hook.js`) into the source
 *  file that must exist for the compiler to emit it (`src/cli/hook.ts`). */
function sourceFor(distRel: string): string {
  const norm = distRel.split(sep).join(posix.sep);
  const rel = norm.startsWith(outDir + "/") ? norm.slice(outDir.length + 1) : norm;
  return join(root, rootDir ?? "src", rel.replace(/\.js$/, ".ts"));
}

describe("PKG-001 package layout", () => {
  it("compiles from a single src rootDir", () => {
    expect(rootDir).toBe("src");
  });

  it("emits every declared bin entry and the main module to declared paths", () => {
    const targets = Object.values(pkg.bin ?? {});
    if (pkg.main) targets.push(pkg.main);
    for (const t of targets) {
      expect(t.startsWith(outDir + "/")).toBe(true);
      expect(existsSync(sourceFor(t))).toBe(true);
    }
  });

  it("declares the three runtime binaries", () => {
    expect(Object.keys(pkg.bin ?? {}).sort()).toEqual(["termyte", "termyte-hook", "termyte-worker"]);
  });

  it("emits the OpenCode built plugin at the path installers probe", () => {
    // installers/opencode.ts resolves dist/integrations/opencode-plugin/index.js
    const pluginSource = join(root, "src", "integrations", "opencode-plugin", "index.ts");
    const pluginEmit = join(outDir, "integrations", "opencode-plugin", "index.js");
    expect(existsSync(pluginSource)).toBe(true);
    expect(sourceFor(pluginEmit)).toBe(pluginSource);
  });
});