export type DocumentType = "trace" | "observation" | "memory" | "summary" | "episode";

export type RetrievalType = DocumentType | "all";

export type FeedbackEvent = "shown" | "used" | "ignored" | "downranked" | "corrected";

export interface ValidationError {
  code: "INVALID_ARGUMENT";
  message: string;
  field?: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ValidationError };

export interface SearchInput {
  query: string;
  type?: RetrievalType;
  files?: string[];
  repo_id?: string;
  sessionId?: string;
  limit?: number;
}

export interface ContextInput extends SearchInput {
  tokenBudget?: number;
}

export interface FeedbackInput {
  id: string;
  event: FeedbackEvent;
  contextInjectionId?: string;
}

export interface GetTraceInput {
  id: number;
}

export interface GetObservationInput {
  id: number;
}

export interface GetMemoryInput {
  id: number;
}

export interface ExplainInput {
  id: string;
}

export type HealthInput = Record<string, never>;
export type StatsInput = Record<string, never>;

const RETRIEVAL_TYPES = new Set<RetrievalType>([
  "trace",
  "observation",
  "memory",
  "summary",
  "episode",
  "all",
]);

const FEEDBACK_EVENTS = new Set<FeedbackEvent>([
  "shown",
  "used",
  "ignored",
  "downranked",
  "corrected",
]);

export function invalidArgument(message: string, field?: string): ValidationError {
  return field
    ? { code: "INVALID_ARGUMENT", message, field }
    : { code: "INVALID_ARGUMENT", message };
}

export function parseRetrievalType(type?: string): ValidationResult<DocumentType[] | undefined> {
  if (type === undefined || type === "" || type === "all") {
    return { ok: true, value: undefined };
  }

  if (!RETRIEVAL_TYPES.has(type as RetrievalType)) {
    return {
      ok: false,
      error: invalidArgument(
        "type must be one of: trace, observation, memory, summary, episode, all",
        "type",
      ),
    };
  }

  return { ok: true, value: [type as DocumentType] };
}

export function parseRetrievalTypeName(type: unknown): ValidationResult<RetrievalType | undefined> {
  if (type === undefined || type === null || type === "") return { ok: true, value: undefined };
  if (typeof type !== "string") {
    return { ok: false, error: invalidArgument("type must be a string", "type") };
  }
  const parsed = parseRetrievalType(type);
  if (!parsed.ok) return parsed;
  return { ok: true, value: type as RetrievalType };
}

export function validateSearchInput(args: Record<string, unknown>): ValidationResult<SearchInput> {
  const query = readRequiredString(args, "query");
  if (!query.ok) return query;

  const type = parseRetrievalTypeName(args["type"]);
  if (!type.ok) return type;

  const files = readOptionalStringArray(args, "files", "currentFiles");
  if (!files.ok) return files;

  const limit = readOptionalPositiveInteger(args, "limit", 1, 100);
  if (!limit.ok) return limit;

  const repoId = readOptionalString(args, "repo_id");
  if (!repoId.ok) return repoId;

  const sessionId = readOptionalString(args, "sessionId");
  if (!sessionId.ok) return sessionId;

  return {
    ok: true,
    value: {
      query: query.value,
      type: type.value,
      files: files.value,
      repo_id: repoId.value,
      sessionId: sessionId.value,
      limit: limit.value,
    },
  };
}

export function validateContextInput(args: Record<string, unknown>): ValidationResult<ContextInput> {
  const search = validateSearchInput(args);
  if (!search.ok) return search;

  const tokenBudget = readOptionalPositiveInteger(args, "tokenBudget", 256, 200_000);
  if (!tokenBudget.ok) return tokenBudget;

  return {
    ok: true,
    value: {
      ...search.value,
      tokenBudget: tokenBudget.value,
    },
  };
}

export function validateFeedbackInput(args: Record<string, unknown>): ValidationResult<FeedbackInput> {
  const id = readRequiredString(args, "id");
  if (!id.ok) return id;

  const event = readRequiredString(args, "event");
  if (!event.ok) return event;
  if (!FEEDBACK_EVENTS.has(event.value as FeedbackEvent)) {
    return {
      ok: false,
      error: invalidArgument("event must be one of: shown, used, ignored, downranked, corrected", "event"),
    };
  }

  const contextInjectionId = readOptionalString(args, "contextInjectionId", "context_injection_id");
  if (!contextInjectionId.ok) return contextInjectionId;

  return {
    ok: true,
    value: {
      id: id.value,
      event: event.value as FeedbackEvent,
      contextInjectionId: contextInjectionId.value,
    },
  };
}

export function validateNumericIdInput(args: Record<string, unknown>, field = "id"): ValidationResult<{ id: number }> {
  const id = readOptionalPositiveInteger(args, field, 1, Number.MAX_SAFE_INTEGER);
  if (!id.ok) return id;
  if (id.value === undefined) {
    return { ok: false, error: invalidArgument(`${field} is required`, field) };
  }
  return { ok: true, value: { id: id.value } };
}

export function validateExplainInput(args: Record<string, unknown>): ValidationResult<ExplainInput> {
  const id = readRequiredString(args, "id");
  if (!id.ok) return id;
  return { ok: true, value: { id: id.value } };
}

function readRequiredString(args: Record<string, unknown>, field: string): ValidationResult<string> {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, error: invalidArgument(`${field} is required`, field) };
  }
  return { ok: true, value: value.trim() };
}

function readOptionalString(
  args: Record<string, unknown>,
  field: string,
  alias?: string,
): ValidationResult<string | undefined> {
  const value = args[field] ?? (alias ? args[alias] : undefined);
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, error: invalidArgument(`${field} must be a string`, field) };
  }
  return { ok: true, value: value.trim() || undefined };
}

function readOptionalStringArray(
  args: Record<string, unknown>,
  field: string,
  alias?: string,
): ValidationResult<string[] | undefined> {
  const value = args[field] ?? (alias ? args[alias] : undefined);
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { ok: false, error: invalidArgument(`${field} must be an array of strings`, field) };
  }
  return {
    ok: true,
    value: value.map((item) => item.trim()).filter(Boolean),
  };
}

function readOptionalPositiveInteger(
  args: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
): ValidationResult<number | undefined> {
  const value = args[field];
  if (value === undefined || value === null || value === "") return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return { ok: false, error: invalidArgument(`${field} must be an integer from ${min} to ${max}`, field) };
  }
  return { ok: true, value };
}
