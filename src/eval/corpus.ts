import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryType, Trace } from "../core/types.js";

export interface EvalMemoryFixture {
  id: string;
  type: MemoryType;
  title: string;
  description: string;
  filesRead?: string[];
  filesModified?: string[];
  keywords?: string[];
}

export interface EvalQueryFixture {
  query: string;
  expectedDocIds: string[];
  expectedKeywords: string[];
}

export interface EvalCorpusCase {
  id: string;
  trace: Partial<Trace> & {
    event_type?: Trace["event_type"];
    user_prompt?: string | null;
  };
  expectedObservations: Array<{
    type: MemoryType;
    title: string;
    description: string;
  }>;
  expectedMemories: EvalMemoryFixture[];
  queries: EvalQueryFixture[];
}

export function loadRegressionCorpus(path = defaultCorpusPath()): EvalCorpusCase[] {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return validateCorpus(parsed, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return BUILT_IN_REGRESSION_CORPUS;
    }
    throw error;
  }
}

export function defaultCorpusPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "test", "fixtures", "regression-corpus", "cases.json");
}

function validateCorpus(value: unknown, source: string): EvalCorpusCase[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid eval corpus ${source}: root must be an array`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid eval corpus ${source}: case ${index} is not an object`);
    }
    if (typeof item.id !== "string") {
      throw new Error(`Invalid eval corpus ${source}: case ${index} missing string id`);
    }
    if (!Array.isArray(item.expectedMemories)) {
      throw new Error(`Invalid eval corpus ${source}: case ${item.id} missing expectedMemories`);
    }
    if (!Array.isArray(item.queries)) {
      throw new Error(`Invalid eval corpus ${source}: case ${item.id} missing queries`);
    }
    return item as unknown as EvalCorpusCase;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export const BUILT_IN_REGRESSION_CORPUS: EvalCorpusCase[] = [
  {
    id: "case_sqlite_vec_001",
    trace: { event_type: "tool_use", user_prompt: "Migrate vector search to sqlite-vec." },
    expectedObservations: [
      { type: "fact", title: "sqlite-vec retrieval decision", description: "Vector search should use sqlite-vec native lookup." },
    ],
    expectedMemories: [
      {
        id: "memory:sqlite_vec_decision",
        type: "convention",
        title: "Use sqlite-vec for dense retrieval",
        description: "Termyte vector search must use sqlite-vec native tables instead of scanning embedding BLOBs.",
        filesModified: ["src/indexing/sqlite-vec-index.ts", "src/retrieval/hybrid-engine.ts"],
        keywords: ["sqlite-vec", "vector", "dense"],
      },
    ],
    queries: [
      {
        query: "How should vector search work?",
        expectedDocIds: ["memory:sqlite_vec_decision"],
        expectedKeywords: ["sqlite-vec", "vector"],
      },
    ],
  },
  {
    id: "case_storage_migration_002",
    trace: { event_type: "tool_use", user_prompt: "Add migration for jobs table." },
    expectedObservations: [
      { type: "procedure", title: "storage migration decision", description: "Migrations must be idempotent." },
    ],
    expectedMemories: [
      {
        id: "memory:idempotent_migrations",
        type: "procedure",
        title: "Keep SQLite migrations idempotent",
        description: "Schema updates must use CREATE IF NOT EXISTS and add-column guards so existing Termyte databases migrate safely.",
        filesModified: ["src/storage/migrations.ts"],
        keywords: ["migration", "idempotent"],
      },
    ],
    queries: [
      {
        query: "How should storage migrations be written?",
        expectedDocIds: ["memory:idempotent_migrations"],
        expectedKeywords: ["migration", "idempotent"],
      },
    ],
  },
];
