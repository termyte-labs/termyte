import { describe, expect, it } from "vitest";
import { MCP_TOOL_DEFS } from "../src/server/mcp/tools.js";
import {
  parseRetrievalType,
  validateContextInput,
  validateFeedbackInput,
  validateNumericIdInput,
  validateSearchInput,
} from "../src/server/mcp/schemas.js";

describe("MCP schema helpers", () => {
  it("maps typed retrieval names to document type filters", () => {
    expect(parseRetrievalType(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseRetrievalType("all")).toEqual({ ok: true, value: undefined });
    expect(parseRetrievalType("trace")).toEqual({ ok: true, value: ["trace"] });
    expect(parseRetrievalType("observation")).toEqual({ ok: true, value: ["observation"] });
    expect(parseRetrievalType("memory")).toEqual({ ok: true, value: ["memory"] });
    expect(parseRetrievalType("summary")).toEqual({ ok: true, value: ["summary"] });
    expect(parseRetrievalType("episode")).toEqual({ ok: true, value: ["episode"] });
  });

  it("returns a stable structured error for invalid retrieval type", () => {
    const result = parseRetrievalType("memory_type_fact");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "INVALID_ARGUMENT",
        message: "type must be one of: trace, observation, memory, summary, episode, all",
        field: "type",
      });
    }
  });

  it("validates search input and currentFiles alias", () => {
    const result = validateSearchInput({
      query: "sqlite vector",
      type: "memory",
      currentFiles: [" src/retrieval/hybrid.ts ", ""],
      repo_id: "github.com/acme/repo",
      limit: 12,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        query: "sqlite vector",
        type: "memory",
        files: ["src/retrieval/hybrid.ts"],
        repo_id: "github.com/acme/repo",
        sessionId: undefined,
        limit: 12,
      });
    }
  });

  it("rejects malformed search input", () => {
    const result = validateSearchInput({
      query: "sqlite vector",
      files: ["ok.ts", 42],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ARGUMENT");
      expect(result.error.field).toBe("files");
    }
  });

  it("validates context token budget", () => {
    const result = validateContextInput({
      query: "memory pipeline",
      type: "all",
      tokenBudget: 4000,
      limit: 10,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tokenBudget).toBe(4000);
    }
  });

  it("rejects invalid context token budget", () => {
    const result = validateContextInput({
      query: "memory pipeline",
      tokenBudget: 10,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.field).toBe("tokenBudget");
    }
  });

  it("validates explicit feedback input without accepting unknown events", () => {
    expect(validateFeedbackInput({
      id: "memory:1",
      event: "used",
      context_injection_id: "ctx_1",
    })).toEqual({
      ok: true,
      value: {
        id: "memory:1",
        event: "used",
        contextInjectionId: "ctx_1",
        correctionText: undefined,
      },
    });
    expect(validateFeedbackInput({ id: "memory:1", event: "helpful" }).ok).toBe(false);
    expect(validateFeedbackInput({ id: "memory:1", event: "harmful", contextInjectionId: "ctx_1" }).ok).toBe(true);
    expect(validateFeedbackInput({ id: "memory:1", event: "corrected", contextInjectionId: "ctx_1" }).ok).toBe(false);
    expect(validateFeedbackInput({
      id: "memory:1", event: "corrected", contextInjectionId: "ctx_1", correctionText: "Use the current API",
    }).ok).toBe(true);

    const invalid = validateFeedbackInput({ id: "memory:1", event: "boost" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.field).toBe("event");
  });

  it("validates numeric id inputs", () => {
    expect(validateNumericIdInput({ id: 7 })).toEqual({ ok: true, value: { id: 7 } });

    const invalid = validateNumericIdInput({ id: "7" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.field).toBe("id");
  });

  it("publishes the new termyte MCP tool names", () => {
    const names = MCP_TOOL_DEFS.map((tool) => tool.name);

    expect(names).toContain("termyte.search");
    expect(names).toContain("termyte.context");
    expect(names).toContain("termyte.get_trace");
    expect(names).toContain("termyte.get_observation");
    expect(names).toContain("termyte.get_memory");
    expect(names).toContain("termyte.feedback");
    expect(names).toContain("termyte.explain");
    expect(names).toContain("termyte.health");
    expect(names).toContain("termyte.stats");
  });
});