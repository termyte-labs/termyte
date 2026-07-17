import type { ToolDef } from "./types.js";

export const TERMYTE_TOOL_DEFS: ToolDef[] = [
  {
    name: "termyte.search",
    description: "Search Termyte memory/context documents with typed retrieval filters.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["trace", "observation", "memory", "summary", "episode", "all"] },
        files: { type: "array", items: { type: "string" } },
        repo_id: { type: "string" },
        sessionId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "termyte.context",
    description: "Build an attributable context packet. Returns contextPacketId and a contextInjectionId only when context was delivered.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["trace", "observation", "memory", "summary", "episode", "all"] },
        files: { type: "array", items: { type: "string" } },
        repo_id: { type: "string" },
        sessionId: { type: "string" },
        limit: { type: "number" },
        tokenBudget: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "termyte.get_trace",
    description: "Fetch a trace by numeric id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "termyte.get_observation",
    description: "Fetch an observation by numeric id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "termyte.get_memory",
    description: "Fetch a memory by numeric id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "termyte.feedback",
    description: "Record explicit feedback for a memory that was present in the named context injection.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        event: { type: "string", enum: ["shown", "used", "helpful", "harmful", "ignored", "downranked", "corrected"] },
        contextInjectionId: { type: "string" },
        correctionText: { type: "string", description: "Required when event=corrected: the replacement knowledge to verify and persist." },
      },
      required: ["id", "event", "contextInjectionId"],
    },
  },
  {
    name: "termyte.explain",
    description: "Explain a memory with provenance, lifecycle, feedback, and measured context effects.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "termyte.health",
    description: "Report local database, queue, and retrieval health.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "termyte.stats",
    description: "Report local Termyte storage and retrieval statistics.",
    inputSchema: { type: "object", properties: {} },
  },
];

export const LEGACY_TOOL_DEFS: ToolDef[] = [
  {
    name: "search_memories",
    description: "Legacy alias for termyte.search over current memory rows.",
    inputSchema: TERMYTE_TOOL_DEFS[0]!.inputSchema,
  },
  {
    name: "get_memory",
    description: "Legacy alias for termyte.get_memory.",
    inputSchema: TERMYTE_TOOL_DEFS[4]!.inputSchema,
  },
  {
    name: "get_recent_sessions",
    description: "List the most recent sessions, newest first.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" } },
    },
  },
  {
    name: "get_session",
    description: "Get a session by id, including summary if available.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "get_observations_for_session",
    description: "List observations extracted during a session.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        limit: { type: "number" },
      },
      required: ["session_id"],
    },
  },
];

export const MCP_TOOL_DEFS: ToolDef[] = [...TERMYTE_TOOL_DEFS, ...LEGACY_TOOL_DEFS];
