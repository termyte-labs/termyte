import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTermyte } from "../src/index.js";

describe("offline runtime providers", () => {
  let homeDir: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let originalDb: string | undefined;
  let originalLlmProvider: string | undefined;
  let originalEmbedProvider: string | undefined;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "termyte-offline-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    originalDb = process.env.TERMYTE_DB;
    originalLlmProvider = process.env.TERMYTE_LLM_PROVIDER;
    originalEmbedProvider = process.env.TERMYTE_EMBED_PROVIDER;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.env.TERMYTE_DB = join(homeDir, "termyte.db");
    process.env.TERMYTE_LLM_PROVIDER = "fake";
    process.env.TERMYTE_EMBED_PROVIDER = "noop";
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    if (originalDb === undefined) delete process.env.TERMYTE_DB;
    else process.env.TERMYTE_DB = originalDb;
    if (originalLlmProvider === undefined) delete process.env.TERMYTE_LLM_PROVIDER;
    else process.env.TERMYTE_LLM_PROVIDER = originalLlmProvider;
    if (originalEmbedProvider === undefined) delete process.env.TERMYTE_EMBED_PROVIDER;
    else process.env.TERMYTE_EMBED_PROVIDER = originalEmbedProvider;
    rmSync(homeDir, { recursive: true, force: true });
  });

  it("captures, synthesizes, consolidates, and retrieves a trace with fake offline providers", async () => {
    const termyte = createTermyte({
      dbPath: process.env.TERMYTE_DB,
      llm: { baseUrl: "http://example.invalid", apiKey: "", model: "fake" },
      embeddings: { model: null },
    });

    try {
      mkdirSync(join(homeDir, "repo"), { recursive: true });
      mkdirSync(join(homeDir, "repo", "src"), { recursive: true });
      writeFileSync(join(homeDir, "repo", "src", "app.ts"), "export const app = true;\n");
      const ok = await termyte.runner.processRaw("raw", {
        session_id: "offline-session",
        cwd: join(homeDir, "repo"),
        timestamp: 1_700_000_000_000,
        tool_name: "Bash",
        tool_input: { command: "npm test", file_path: "src/app.ts" },
        tool_output: { status: "ok" },
      });

      expect(ok).toBe(true);

      await termyte.observer.flush();

      const observations = termyte.store.getRecentObservations(10);
      expect(observations).toHaveLength(1);
      expect(observations[0]!.title).toContain("npm test");

      const memories = termyte.store.getRecentMemories(10);
      expect(memories.length).toBeGreaterThan(0);
      expect(memories[0]!.title).toContain("Consolidated");

      const context = await termyte.context.build({
        repo_id: "unknown",
        maxMemories: 5,
        sessionId: "offline-session",
      });
      expect(context.text).toContain("npm test");
      expect(context.contextInjectionId).toBeTruthy();

      const summary = termyte.store.getSummary("offline-session");
      expect(summary).not.toBeNull();
      expect(summary!.summary).toContain("offline session");
    } finally {
      termyte.close();
    }
  });
});