import { describe, it, expect } from "vitest";
import { extractFilesFromEvent } from "../src/capture/files.js";

describe("extractFilesFromEvent", () => {
  it("classifies Read as a read", () => {
    const f = extractFilesFromEvent("Read", { file_path: "src/a.ts" });
    expect(f.read).toEqual(["src/a.ts"]);
    expect(f.modified).toEqual([]);
  });

  it("classifies Write as a modify", () => {
    const f = extractFilesFromEvent("Write", { file_path: "src/a.ts" });
    expect(f.modified).toEqual(["src/a.ts"]);
    expect(f.read).toEqual([]);
  });

  it("classifies Edit as a modify", () => {
    const f = extractFilesFromEvent("Edit", { file_path: "src/a.ts", old_string: "x", new_string: "y" });
    expect(f.modified).toEqual(["src/a.ts"]);
  });

  it("classifies Glob as a read (the pattern is a file ref)", () => {
    const f = extractFilesFromEvent("Glob", { pattern: "src/**/*.ts" });
    expect(f.read).toEqual(["src/**/*.ts"]);
  });

  it("parses Bash commands for file paths", () => {
    const cmd = "cat src/a.ts | head -n 5 > /tmp/out";
    const f = extractFilesFromEvent("Bash", { command: cmd });
    expect(f.read).toContain("src/a.ts");
    expect(f.read).toContain("/tmp/out");
  });

  it("picks up files in Edit.edits[]", () => {
    const f = extractFilesFromEvent("Edit", {
      edits: [
        { file_path: "src/a.ts" },
        { file_path: "src/b.ts" },
      ],
    });
    expect(f.modified).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("returns empty for unknown tools with no path field", () => {
    const f = extractFilesFromEvent("Unknown", { foo: "bar" });
    expect(f.read).toEqual([]);
    expect(f.modified).toEqual([]);
  });

  it("returns empty for null input", () => {
    const f = extractFilesFromEvent("Read", null);
    expect(f.read).toEqual([]);
    expect(f.modified).toEqual([]);
  });
});