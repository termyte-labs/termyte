import { describe, it, expect } from "vitest";
import { parseAgentXml } from "../src/observer/parser.js";

describe("parseAgentXml", () => {
  it("parses a single observation", () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>Auth fails with trailing space</title>
      <description>Tokens had trailing spaces causing auth failures. Fixed by trimming.</description>
      <files_read><file>src/auth/token.ts</file></files_read>
      <files_modified><file>src/auth/token.ts</file></files_modified>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.type).toBe("bugfix");
    expect(obs.title).toBe("Auth fails with trailing space");
    expect(obs.description).toBe("Tokens had trailing spaces causing auth failures. Fixed by trimming.");
    expect(obs.files_read).toEqual(["src/auth/token.ts"]);
    expect(obs.files_modified).toEqual(["src/auth/token.ts"]);
  });

  it("parses multiple observations", () => {
    const xml = `<observation>
      <type>fact</type>
      <title>First</title>
    </observation>
    <observation>
      <type>procedure</type>
      <title>Second</title>
      <description>How to deploy</description>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]!.title).toBe("First");
    expect(result.observations[1]!.title).toBe("Second");
  });

  it("falls back to fact for invalid type", () => {
    const xml = `<observation>
      <type>not-a-real-type</type>
      <title>Fallback</title>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.type).toBe("fact");
  });

  it("accepts all valid types", () => {
    for (const t of ["bugfix", "convention", "warning", "procedure", "fact"]) {
      const xml = `<observation><type>${t}</type><title>x</title></observation>`;
      const result = parseAgentXml(xml);
      expect(result.valid).toBe(true);
      if (!result.valid) continue;
      expect(result.observations[0]!.type).toBe(t);
    }
  });

  it("drops empty observations (no title, no description)", () => {
    const xml = `<observation>
      <type>fact</type>
    </observation>
    <observation>
      <type>fact</type>
      <title>Real</title>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.title).toBe("Real");
  });

  it("parses a summary", () => {
    const xml = `<summary>
      <summary_text>Fixed the login bug by trimming auth tokens.</summary_text>
      <key_changes>
        <change>Trim tokens in auth middleware</change>
        <change>Added token validation tests</change>
      </key_changes>
      <key_learnings>
        <learning>External IdP tokens may contain whitespace</learning>
      </key_learnings>
    </summary>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.summary).not.toBeNull();
    expect(result.summary!.summary_text).toBe("Fixed the login bug by trimming auth tokens.");
    expect(result.summary!.key_changes).toEqual(["Trim tokens in auth middleware", "Added token validation tests"]);
    expect(result.summary!.key_learnings).toEqual(["External IdP tokens may contain whitespace"]);
  });

  it("parses a skip_summary as a valid empty response", () => {
    const xml = `<skip_summary />`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(0);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.skipped).toBe(true);
  });

  it("returns invalid for non-XML text", () => {
    expect(parseAgentXml("just some prose").valid).toBe(false);
    expect(parseAgentXml("").valid).toBe(false);
    expect(parseAgentXml("   \n  ").valid).toBe(false);
  });

  it("returns invalid for empty summary (no sub-tags)", () => {
    const xml = `<summary></summary>`;
    expect(parseAgentXml(xml).valid).toBe(false);
  });

  it("strips code fences", () => {
    const xml = "```xml\n<observation>\n<type>bugfix</type>\n<title>fenced</title>\n<description>desc</description>\n</observation>\n```";
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.title).toBe("fenced");
  });
});
