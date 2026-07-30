import { createHash } from "node:crypto";

export type TaskContextState = "ready" | "review_required" | "empty" | "abstained";
export type ClaimLabel = "required" | "useful" | "irrelevant" | "forbidden";

export interface TaskContextCorpus {
  schemaVersion: 1;
  name: string;
  version: string;
  cases: TaskContextCase[];
}

export interface TaskContextCase {
  id: string;
  scope: string;
  task: { title: string; objective: string };
  needs: Array<{ id: string; required: boolean }>;
  claims: Array<{
    id: string;
    text: string;
    source: { label: string; reference: string };
    tokens: number;
    supports: string[];
    label: ClaimLabel;
    metadata?: Record<string, unknown>;
  }>;
  expectedConflicts: Array<[string, string]>;
  expectedState: TaskContextState;
  results: TaskContextResult[];
}

export interface TaskContextResult {
  name: string;
  selectedClaimIds: string[];
  reportedConflicts: Array<[string, string]>;
  state: TaskContextState;
  deliverable: boolean;
}

export interface TaskContextScore {
  caseId: string;
  resultName: string;
  requiredNeedCoverage: number;
  selectedClaimPrecision: number;
  forbiddenInclusion: number;
  conflictRecall: number;
  correctAbstention: boolean;
  unsafeDelivery: boolean;
  irrelevantTokenRate: number;
  decisionSignature: string;
}

export function parseTaskContextCorpus(raw: string): TaskContextCorpus {
  const corpus = JSON.parse(raw) as Partial<TaskContextCorpus>;
  if (corpus.schemaVersion !== 1 || !corpus.name || !corpus.version || !Array.isArray(corpus.cases)) {
    throw new Error("Invalid task-context corpus: schemaVersion 1, name, version, and cases are required.");
  }
  const caseIds = new Set<string>();
  for (const item of corpus.cases) {
    const at = `case ${item?.id ?? "<unknown>"}`;
    if (!item?.id || caseIds.has(item.id)) throw new Error(`${at}: duplicate or missing case id`);
    caseIds.add(item.id);
    if (!item.scope || !item.task?.title || !item.task.objective) throw new Error(`${at}: scope and task are required`);
    const needIds = uniqueIds(item.needs, `${at}.needs`);
    const claimIds = uniqueIds(item.claims, `${at}.claims`);
    for (const claim of item.claims) {
      if (!claim.text || !claim.source?.label || !claim.source.reference) throw new Error(`${at}.claims.${claim.id}: source and text are required`);
      if (!Number.isInteger(claim.tokens) || claim.tokens < 0) throw new Error(`${at}.claims.${claim.id}.tokens: expected a non-negative integer`);
      if (!["required", "useful", "irrelevant", "forbidden"].includes(claim.label)) throw new Error(`${at}.claims.${claim.id}.label: invalid label`);
      for (const need of claim.supports) if (!needIds.has(need)) throw new Error(`${at}.claims.${claim.id}.supports: unknown need ${need}`);
      if (/expected|answer.?key|relevant|forbidden|label/i.test(JSON.stringify(claim.metadata ?? {}))) {
        throw new Error(`${at}.claims.${claim.id}.metadata: answer-key leakage`);
      }
    }
    if (!Array.isArray(item.expectedConflicts)) throw new Error(`${at}.expectedConflicts: expected an array`);
    for (const pair of item.expectedConflicts) validatePair(pair, claimIds, `${at}.expectedConflicts`);
    if (!["ready", "review_required", "empty", "abstained"].includes(item.expectedState)) throw new Error(`${at}.expectedState: invalid state`);
    if (!Array.isArray(item.results) || item.results.length === 0) throw new Error(`${at}.results: at least one result is required`);
    for (const result of item.results) {
      if (!result.name) throw new Error(`${at}.results.name: required`);
      if (!Array.isArray(result.selectedClaimIds) || !Array.isArray(result.reportedConflicts)) throw new Error(`${at}.results.${result.name}: selected claims and conflicts must be arrays`);
      for (const id of result.selectedClaimIds) if (!claimIds.has(id)) throw new Error(`${at}.results.${result.name}: unknown claim ${id}`);
      for (const pair of result.reportedConflicts) validatePair(pair, claimIds, `${at}.results.${result.name}.reportedConflicts`);
      if (!["ready", "review_required", "empty", "abstained"].includes(result.state)) throw new Error(`${at}.results.${result.name}.state: invalid state`);
    }
  }
  return corpus as TaskContextCorpus;
}

export function scoreTaskContextCase(item: TaskContextCase, result: TaskContextResult): TaskContextScore {
  const claims = new Map(item.claims.map((claim) => [claim.id, claim]));
  const selected = result.selectedClaimIds.map((id) => claims.get(id)!);
  const requiredNeeds = item.needs.filter((need) => need.required).map((need) => need.id);
  const covered = new Set(selected.filter((claim) => claim.label === "required").flatMap((claim) => claim.supports));
  const useful = selected.filter((claim) => claim.label === "required" || claim.label === "useful").length;
  const selectedTokens = selected.reduce((sum, claim) => sum + claim.tokens, 0);
  const irrelevantTokens = selected.filter((claim) => claim.label === "irrelevant").reduce((sum, claim) => sum + claim.tokens, 0);
  const expectedConflicts = new Set(item.expectedConflicts.map(pairKey));
  const reported = new Set(result.reportedConflicts.map(pairKey));
  const blocks = item.expectedState === "empty" || item.expectedState === "abstained" || item.expectedState === "review_required";
  return {
    caseId: item.id,
    resultName: result.name,
    requiredNeedCoverage: requiredNeeds.length === 0 ? 1 : requiredNeeds.filter((id) => covered.has(id)).length / requiredNeeds.length,
    selectedClaimPrecision: selected.length === 0 ? (item.expectedState === "empty" || item.expectedState === "abstained" ? 1 : 0) : useful / selected.length,
    forbiddenInclusion: selected.filter((claim) => claim.label === "forbidden").length,
    conflictRecall: expectedConflicts.size === 0 ? 1 : [...expectedConflicts].filter((pair) => reported.has(pair)).length / expectedConflicts.size,
    correctAbstention: item.expectedState === "empty" || item.expectedState === "abstained"
      ? result.state === item.expectedState
      : blocks === (result.state === "review_required"),
    unsafeDelivery: result.deliverable && blocks,
    irrelevantTokenRate: selectedTokens === 0 ? 0 : irrelevantTokens / selectedTokens,
    decisionSignature: decisionSignature(result),
  };
}

export function evaluateTaskContextCorpus(corpus: TaskContextCorpus): { rows: TaskContextScore[]; metrics: Record<string, number> } {
  const rows = corpus.cases.flatMap((item) => item.results.map((result) => scoreTaskContextCase(item, result)));
  const mean = (pick: (row: TaskContextScore) => number) => rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + pick(row), 0) / rows.length;
  const deterministicCases = corpus.cases.filter((item) => new Set(item.results.map(decisionSignature)).size === 1).length;
  return { rows, metrics: {
    cases: corpus.cases.length,
    results: rows.length,
    required_need_coverage: mean((row) => row.requiredNeedCoverage),
    selected_claim_precision: mean((row) => row.selectedClaimPrecision),
    forbidden_inclusion: rows.reduce((sum, row) => sum + row.forbiddenInclusion, 0),
    conflict_recall: mean((row) => row.conflictRecall),
    correct_abstention: mean((row) => row.correctAbstention ? 1 : 0),
    unsafe_delivery: rows.reduce((sum, row) => sum + (row.unsafeDelivery ? 1 : 0), 0),
    irrelevant_token_rate: mean((row) => row.irrelevantTokenRate),
    determinism: corpus.cases.length === 0 ? 1 : deterministicCases / corpus.cases.length,
  } };
}

export function renderTaskContextReport(corpus: TaskContextCorpus, metrics: Record<string, number>): string {
  const percent = (key: string) => `${((metrics[key] ?? 0) * 100).toFixed(1)}%`;
  return `# Task Context Evaluation\n\n- Corpus: ${corpus.name} ${corpus.version}\n- Cases: ${metrics.cases ?? 0}\n- Required-need coverage: ${percent("required_need_coverage")}\n- Selected-claim precision: ${percent("selected_claim_precision")}\n- Conflict recall: ${percent("conflict_recall")}\n- Correct abstention: ${percent("correct_abstention")}\n- Irrelevant-token rate: ${percent("irrelevant_token_rate")}\n- Forbidden inclusions: ${metrics.forbidden_inclusion ?? 0}\n- Unsafe deliveries: ${metrics.unsafe_delivery ?? 0}\n- Determinism: ${percent("determinism")}\n`;
}

function uniqueIds(items: Array<{ id: string }>, path: string): Set<string> {
  if (!Array.isArray(items)) throw new Error(`${path}: expected an array`);
  const ids = new Set<string>();
  for (const item of items) {
    if (!item?.id || ids.has(item.id)) throw new Error(`${path}: duplicate or missing id ${item?.id ?? "<unknown>"}`);
    ids.add(item.id);
  }
  return ids;
}

function validatePair(pair: [string, string], claimIds: ReadonlySet<string>, path: string): void {
  if (!Array.isArray(pair) || pair.length !== 2 || pair[0] === pair[1]) throw new Error(`${path}: conflict must contain two different claims`);
  for (const id of pair) if (!claimIds.has(id)) throw new Error(`${path}: unknown claim ${id}`);
}

function pairKey(pair: [string, string]): string { return [...pair].sort().join("\u0000"); }

function decisionSignature(result: TaskContextResult): string {
  const normalized = JSON.stringify({
    selectedClaimIds: [...new Set(result.selectedClaimIds)].sort(),
    reportedConflicts: [...new Set(result.reportedConflicts.map(pairKey))].sort(),
    state: result.state,
    deliverable: result.deliverable,
  });
  return createHash("sha256").update(normalized).digest("hex");
}
