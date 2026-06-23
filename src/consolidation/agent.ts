import type Database from "better-sqlite3";
import type { Memory, MemoryType, ConsolidationKind } from "../types.js";
import { generateId, nowISO } from "../utils.js";
import type { GeminiClient } from "../extraction/gemini.js";
import { CONSOLIDATE_SYSTEM_PROMPT, buildConsolidationPrompt } from "./prompts.js";

export type ConsolidationAction =
  | { kind: "merge"; sourceIndices: number[]; claim: string; type: MemoryType; language: string | null; rationale: string }
  | { kind: "compress"; sourceIndices: number[]; claim: string; type: MemoryType; language: string | null; rationale: string }
  | { kind: "synthesize"; sourceIndices: number[]; claim: string; type: MemoryType; language: string | null; rationale: string };

export interface ConsolidationPlan {
  actions: ConsolidationAction[];
}

export interface ConsolidationResult {
  scope: string;
  considered: number;
  merged: number;
  compressed: number;
  synthesized: number;
  kept: number;
  newMemoryIds: string[];
  deactivatedIds: string[];
  skipped?: string;
}

export interface ConsolidateOptions {
  scope?: string;
  minMemories?: number;
  maxBatch?: number;
  dryRun?: boolean;
}

const DEFAULT_MIN_MEMORIES = 3;
const DEFAULT_MAX_BATCH = 50;

export async function consolidateProject(
  db: Database.Database,
  gemini: GeminiClient,
  options: ConsolidateOptions = {},
): Promise<ConsolidationResult> {
  const minMemories = options.minMemories ?? DEFAULT_MIN_MEMORIES;
  const maxBatch = options.maxBatch ?? DEFAULT_MAX_BATCH;
  const scopes = options.scope
    ? [options.scope]
    : listActiveScopes(db);
  if (scopes.length === 0) {
    return {
      scope: options.scope ?? "",
      considered: 0,
      merged: 0,
      compressed: 0,
      synthesized: 0,
      kept: 0,
      newMemoryIds: [],
      deactivatedIds: [],
      skipped: "no_active_scopes",
    };
  }

  const out: ConsolidationResult = {
    scope: scopes.join(","),
    considered: 0,
    merged: 0,
    compressed: 0,
    synthesized: 0,
    kept: 0,
    newMemoryIds: [],
    deactivatedIds: [],
  };

  for (const scope of scopes) {
    const memories = listActiveMemoriesForScope(db, scope, maxBatch);
    if (memories.length < minMemories) {
      out.skipped = `scope:${scope}_below_threshold`;
      continue;
    }
    out.considered += memories.length;

    const plan = await planConsolidation(gemini, memories);
    if (plan.actions.length === 0) {
      out.kept += memories.length;
      continue;
    }

    if (options.dryRun) {
      for (const a of plan.actions) {
        if (a.kind === "merge") out.merged += a.sourceIndices.length;
        else if (a.kind === "compress") out.compressed += 1;
        else if (a.kind === "synthesize") out.synthesized += a.sourceIndices.length;
      }
      continue;
    }

    applyConsolidationPlan(db, memories, plan, out);
  }

  return out;
}

export function listActiveScopes(db: Database.Database): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT repo_scope FROM memories WHERE is_active = 1 ORDER BY repo_scope",
  ).all() as Array<{ repo_scope: string }>;
  return rows.map((r) => r.repo_scope);
}

export function listActiveMemoriesForScope(
  db: Database.Database,
  scope: string,
  limit: number,
): Memory[] {
  const rows = db.prepare(
    "SELECT * FROM memories WHERE is_active = 1 AND repo_scope = ? ORDER BY updated_at DESC LIMIT ?",
  ).all(scope, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToMemoryShim);
}

function rowToMemoryShim(row: Record<string, unknown>): Memory {
  const get = (k: string) => row[k];
  return {
    id: String(get("id")),
    claim: String(get("claim")),
    type: get("type") as MemoryType,
    repoScope: String(get("repo_scope")),
    language: (get("language") as string | null) ?? undefined,
    astAnchors: get("ast_anchors") ? safeJson(get("ast_anchors")) as Memory["astAnchors"] : undefined,
    sources: safeJson(get("sources")) as string[],
    filesRead: (get("files_read") as string | null) ?? undefined,
    filesModified: (get("files_modified") as string | null) ?? undefined,
    concepts: (get("concepts") as string | null) ?? undefined,
    embedding: (get("embedding") as Buffer | null) ?? undefined,
    successCount: Number(get("success_count") ?? 0),
    failureCount: Number(get("failure_count") ?? 0),
    confidence: Number(get("confidence") ?? 0.5),
    lastOutcomeAt: (get("last_outcome_at") as string | null) ?? undefined,
    lastOutcomeType: (get("last_outcome_type") as string | null) ?? undefined,
    consolidatedFrom: get("consolidated_from") ? safeJson(get("consolidated_from")) as string[] : undefined,
    consolidationKind: (get("consolidation_kind") as ConsolidationKind | null) ?? undefined,
    consolidationRationale: (get("consolidation_rationale") as string | null) ?? undefined,
    createdAt: String(get("created_at")),
    updatedAt: String(get("updated_at")),
    isActive: Number(get("is_active") ?? 1) === 1,
  };
}

function safeJson(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

export async function planConsolidation(
  gemini: GeminiClient,
  memories: Memory[],
): Promise<ConsolidationPlan> {
  const claims = memories.map((m) => ({
    claim: m.claim,
    type: m.type,
    repoScope: m.repoScope,
    language: m.language,
  }));
  const userPrompt = buildConsolidationPrompt(claims);
  const response = await gemini.generateStructured(
    CONSOLIDATE_SYSTEM_PROMPT,
    userPrompt,
    CONSOLIDATION_RESPONSE_SCHEMA,
  );
  return normalizePlan(response);
}

const CONSOLIDATION_RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["merge", "compress", "synthesize"] },
          sourceIndices: { type: "array", items: { type: "integer" } },
          claim: { type: "string" },
          type: { type: "string", enum: ["fact", "bugfix", "procedure", "convention", "warning"] },
          language: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["kind", "sourceIndices", "claim", "type", "rationale"],
      },
    },
  },
  required: ["actions"],
};

export function normalizePlan(raw: unknown): ConsolidationPlan {
  if (!raw || typeof raw !== "object") return { actions: [] };
  const actions = (raw as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return { actions: [] };

  const validKinds = new Set<ConsolidationAction["kind"]>(["merge", "compress", "synthesize"]);
  const validTypes = new Set<MemoryType>(["fact", "bugfix", "procedure", "convention", "warning"]);
  const normalized: ConsolidationAction[] = [];
  for (const a of actions) {
    if (!a || typeof a !== "object") continue;
    const obj = a as Record<string, unknown>;
    const kind = obj.kind;
    if (typeof kind !== "string" || !validKinds.has(kind as ConsolidationAction["kind"])) continue;
    const sourceIndices = Array.isArray(obj.sourceIndices)
      ? (obj.sourceIndices as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0)
      : [];
    if (sourceIndices.length === 0) continue;
    const claim = typeof obj.claim === "string" ? obj.claim : "";
    if (!claim) continue;
    const type = obj.type;
    if (typeof type !== "string" || !validTypes.has(type as MemoryType)) continue;
    const language = typeof obj.language === "string" && obj.language.length > 0
      ? obj.language
      : null;
    const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
    normalized.push({ kind: kind as ConsolidationAction["kind"], sourceIndices, claim, type: type as MemoryType, language, rationale });
  }
  return { actions: normalized };
}

function applyConsolidationPlan(
  db: Database.Database,
  memories: Memory[],
  plan: ConsolidationPlan,
  out: ConsolidationResult,
): void {
  const usedIndices = new Set<number>();
  for (const action of plan.actions) {
    const sources = action.sourceIndices
      .filter((i) => i >= 0 && i < memories.length && !usedIndices.has(i))
      .map((i) => memories[i]);
    // Reject actions that don't have enough valid sources:
    //   merge / synthesize need at least 2 distinct memories
    //   compress needs exactly 1
    if (action.kind === "compress") {
      if (sources.length !== 1) continue;
    } else {
      if (sources.length < 2) continue;
    }
    sources.forEach((s) => usedIndices.add(memories.indexOf(s)));
    const validSources = sources as Memory[];

    const newSuccess = validSources.reduce((acc, m) => acc + m.successCount, 0);
    const newFailure = validSources.reduce((acc, m) => acc + m.failureCount, 0);
    const combinedConfidence = (newSuccess + 1) / (newSuccess + newFailure + 2);
    const sourcesList = validSources.map((m) => m.id);
    const unionConcepts = mergeConcepts(validSources);
    const language = action.language ?? validSources[0]?.language;

    const now = nowISO();
    const newId = generateId();
    const insert = db.prepare(`
      INSERT INTO memories (
        id, claim, type, repo_scope, language, sources, concepts,
        success_count, failure_count, confidence,
        consolidated_from, consolidation_kind, consolidation_rationale,
        created_at, updated_at, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);
    insert.run(
      newId,
      action.claim,
      action.type,
      validSources[0]?.repoScope ?? "unknown",
      language ?? null,
      JSON.stringify(sourcesList),
      unionConcepts,
      newSuccess,
      newFailure,
      combinedConfidence,
      JSON.stringify(sourcesList),
      action.kind,
      action.rationale,
      now,
      now,
    );
    syncFtsForMemory(db, newId, action.claim, action.type, validSources[0]?.repoScope ?? "unknown", language ?? "");

    const deactivate = db.prepare("UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?");
    for (const id of sourcesList) {
      deactivate.run(now, id);
      out.deactivatedIds.push(id);
    }
    out.newMemoryIds.push(newId);
    if (action.kind === "merge") out.merged += sourcesList.length;
    else if (action.kind === "compress") out.compressed += 1;
    else if (action.kind === "synthesize") out.synthesized += sourcesList.length;
  }

  const keptCount = memories.length - usedIndices.size;
  if (keptCount > 0) out.kept += keptCount;
}

function mergeConcepts(memories: Memory[]): string | null {
  const set = new Set<string>();
  for (const m of memories) {
    if (!m.concepts) continue;
    try {
      const arr = JSON.parse(m.concepts);
      if (Array.isArray(arr)) {
        for (const c of arr) if (typeof c === "string") set.add(c);
      }
    } catch { /* ignore */ }
  }
  if (set.size === 0) return null;
  return JSON.stringify(Array.from(set));
}

function syncFtsForMemory(
  db: Database.Database,
  id: string,
  claim: string,
  type: string,
  repoScope: string,
  language: string,
): void {
  try {
    const row = db.prepare("SELECT rowid FROM memories WHERE id = ?").get(id) as { rowid: number } | undefined;
    if (!row) return;
    db.prepare("DELETE FROM memories_fts WHERE rowid = ?").run(row.rowid);
    db.prepare(`
      INSERT INTO memories_fts(rowid, claim, type, repo_scope, language)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.rowid, claim, type, repoScope, language);
  } catch (e) {
    if (process.env.TERMYTE_DEBUG_FTS) {
      console.error("[FTS sync error]", e);
    }
  }
}
