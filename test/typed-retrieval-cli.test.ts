import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { searchCommand } from "../src/cli/search.js";
import { contextCommand } from "../src/cli/context.js";
import { Store } from "../src/storage/store.js";
import { DocumentStore } from "../src/storage/documents.js";

const oldDb = process.env.TERMYTE_DB;
let tempDir: string | null = null;

afterEach(() => {
  process.env.TERMYTE_DB = oldDb;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("typed document retrieval CLI", () => {
  it("searches non-memory document types instead of returning empty results", async () => {
    seedObservationDocument();
    const output = await captureStdout(() =>
      searchCommand("observation indexing", { type: "observation", json: true }),
    );

    const parsed = JSON.parse(output) as Array<{ document: { id: string; doc_type: string } }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.document.id).toBe("observation:typed-1");
    expect(parsed[0]!.document.doc_type).toBe("observation");
  });

  it("renders typed context from the document corpus", async () => {
    seedObservationDocument();
    const output = await captureStdout(() =>
      contextCommand({ query: "observation indexing", type: "observation" }),
    );

    expect(output).toContain("# Termyte Context");
    expect(output).toContain("observation:typed-1");
    expect(output).toContain("Observation indexing belongs in the document corpus.");
  });

  it("can write portable repo context to disk", async () => {
    const ctxDir = mkdtempSync(join(tmpdir(), "termyte-context-export-"));
    process.env.TERMYTE_DB = join(ctxDir, "termyte.db");
    const store = new Store(process.env.TERMYTE_DB);
    try {
      store.upsertSession("s1", "repo", "github.com/test/repo", "/w");
      store.insertMemory({
        session_id: "s1",
        repo_id: "github.com/test/repo",
        workspace_root: "/w",
        type: "fact",
        title: "Portable memory",
        description: "This should appear in exported context.",
        files_read: ["src/export.ts"],
        files_modified: [],
        source_observation_ids: [],
        source_trace_ids: [],
        created_at: 100,
        embedding: null,
      });
      const outPath = join(ctxDir, "exports", "context.md");
      await contextCommand({ repo_id: "github.com/test/repo", limit: 5, writeFile: outPath });
      const content = readFileSync(outPath, "utf-8");
      expect(content).toContain("Portable memory");
      expect(content).toContain("This should appear in exported context.");
    } finally {
      store.close();
      rmSync(ctxDir, { recursive: true, force: true });
    }
  });
});

function seedObservationDocument(): void {
  tempDir = mkdtempSync(join(tmpdir(), "termyte-typed-"));
  process.env.TERMYTE_DB = join(tempDir, "termyte.db");
  const store = new Store(process.env.TERMYTE_DB);
  try {
    new DocumentStore(store.getDB()).upsertDocument({
      id: "observation:typed-1",
      doc_type: "observation",
      source_id: "typed-1",
      content: "Observation indexing belongs in the document corpus.",
      files: ["src/storage/documents.ts"],
      tags: ["fact"],
      created_at: 100,
      updated_at: 100,
      recency_ts: 100,
    });
  } finally {
    store.close();
  }
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const originalWrite = process.stdout.write;
  let output = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;

  try {
    await fn();
    return output;
  } finally {
    process.stdout.write = originalWrite;
  }
}
