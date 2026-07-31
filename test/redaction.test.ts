import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase, type DatabaseContext } from "../src/storage/connection.js";
import { Store } from "../src/storage/store.js";
import { buildObservationPrompt, buildSummaryPrompt } from "../src/context/observations/prompts.js";
import { buildBatchPrompt } from "../src/agents/synthesis/prompts.js";
import { redactTracePayload } from "../src/shared/redaction.js";

let ctx: DatabaseContext;

beforeEach(() => {
  ctx = openDatabase(":memory:");
});

describe("redaction", () => {
  it("redacts known secret formats recursively before persistence", () => {
    const store = new Store(ctx);
    store.upsertSession("s1", "demo", "repo", "/work");

    const trace = store.insertTrace({
      session_id: "s1",
      timestamp: 1,
      event_type: "tool_use",
      tool_name: "Bash",
      tool_input: {
        command: "curl https://alice:supersecret@example.com --header 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig'",
        password: "hunter2",
        nested: {
          apiKey: "sk-test-secret-secret-secret-secret",
          private_key: "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
        },
      },
      tool_output: {
        token: "ghp_abcdabcdabcdabcdabcdabcdabcdabcdabcd",
        headers: { authorization: "Bearer xoxb-1234567890-abcdef" },
      },
      files_read: null,
      files_modified: null,
      user_prompt: "Use my token sk-test-secret-secret-secret-secret",
      final_response: "All done with password=topsecret",
    });

    expect(JSON.stringify(trace.tool_input)).not.toContain("supersecret");
    expect(JSON.stringify(trace.tool_input)).not.toContain("hunter2");
    expect(JSON.stringify(trace.tool_input)).not.toContain("sk-test-secret-secret-secret-secret");
    expect(JSON.stringify(trace.tool_output)).not.toContain("ghp_abcdabcdabcdabcdabcdabcdabcdabcdabcd");
    expect(trace.user_prompt).not.toContain("sk-test-secret-secret-secret-secret");
    expect(trace.final_response).not.toContain("topsecret");

    const row = store.getDB().prepare(`SELECT redaction_json FROM traces WHERE id = ?`).get(trace.id) as { redaction_json: string };
    expect(row.redaction_json).toContain("tool_input.password:key");
    expect(row.redaction_json).toContain("tool_output.token:key");
    expect(row.redaction_json).toContain("user_prompt:openai_key");
    expect(row.redaction_json).toContain("final_response:key_value");

    store.close();
  });

  it("redacts prompts sent to observer and synthesis LLMs", () => {
    const observationPrompt = buildObservationPrompt({
      tool_name: "Bash",
      tool_input: {
        command: "export AWS_SECRET_ACCESS_KEY=ABCDEF1234567890ABCD",
        url: "https://user:password@example.com",
      },
      tool_output: "Bearer eyJhbGciOiJIUzI1NiJ9.e30.signature",
      timestamp: 1,
    });
    expect(observationPrompt).not.toContain("ABCDEF1234567890ABCD");
    expect(observationPrompt).not.toContain("password@example.com");
    expect(observationPrompt).not.toContain("eyJhbGci");

    const summaryPrompt = buildSummaryPrompt({
      user_prompts: ["Use token sk-test-secret-secret-secret-secret"],
      final_response: "Done with password=secret123",
      files_modified: ["src/auth.ts"],
    });
    expect(summaryPrompt).not.toContain("sk-test-secret-secret-secret-secret");
    expect(summaryPrompt).not.toContain("secret123");

    const synthesisPrompt = buildBatchPrompt([
      {
        id: 1,
        tool_name: "Bash",
        tool_input: { command: "curl https://alice:pw@example.com" },
        tool_output: { output: "ghp_abcdabcdabcdabcdabcdabcdabcdabcdabcd" },
        user_prompt: "Use password=secret123",
        timestamp: 1,
      },
    ]);
    expect(synthesisPrompt).not.toContain("alice:pw");
    expect(synthesisPrompt).not.toContain("ghp_abcdabcdabcdabcdabcdabcdabcdabcdabcd");
    expect(synthesisPrompt).not.toContain("secret123");
  });

  it("reports redaction metadata even when nested structures are sanitized", () => {
    const result = redactTracePayload({
      tool_input: { nested: [{ password: "hunter2" }] },
      tool_output: null,
      user_prompt: "token sk-test-secret-secret-secret-secret",
      final_response: null,
    });

    expect(result.redaction.applied).toBe(true);
    expect(result.redaction.findings.some((finding) => finding.includes("tool_input.nested[0].password"))).toBe(true);
    expect(result.redaction.findings.some((finding) => finding.includes("user_prompt"))).toBe(true);
  });
});
