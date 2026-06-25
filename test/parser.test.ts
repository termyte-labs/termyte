import { describe, it, expect } from "vitest";
import { parseAgentXml } from "../src/observer/parser.js";

describe("parseAgentXml", () => {
  it("parses a single observation", () => {
    const xml = `<observation>
      <type>bugfix</type>
      <title>Auth fails with trailing space</title>
      <subtitle>Token has whitespace</subtitle>
      <facts><fact>Reproduction: token with trailing space</fact><fact>Fix: trim before use</fact></facts>
      <narrative>Auth path now trims tokens</narrative>
      <concepts><concept>problem-solution</concept></concepts>
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
    expect(obs.subtitle).toBe("Token has whitespace");
    expect(obs.facts).toEqual([
      "Reproduction: token with trailing space",
      "Fix: trim before use",
    ]);
    expect(obs.narrative).toBe("Auth path now trims tokens");
    expect(obs.concepts).toEqual(["problem-solution"]);
    expect(obs.files_read).toEqual(["src/auth/token.ts"]);
    expect(obs.files_modified).toEqual(["src/auth/token.ts"]);
  });

  it("parses multiple observations", () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>First</title>
    </observation>
    <observation>
      <type>decision</type>
      <title>Second</title>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]!.title).toBe("First");
    expect(result.observations[1]!.title).toBe("Second");
  });

  it("falls back to discovery for invalid type", () => {
    const xml = `<observation>
      <type>not-a-real-type</type>
      <title>Fallback</title>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.type).toBe("discovery");
  });

  it("strips the observation type from concepts", () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>t</title>
      <concepts><concept>discovery</concept><concept>how-it-works</concept></concepts>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.concepts).toEqual(["how-it-works"]);
  });

  it("drops unknown concepts", () => {
    const xml = `<observation>
      <type>discovery</type>
      <title>t</title>
      <concepts><concept>how-it-works</concept><concept>mystery</concept></concepts>
    </observation>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.concepts).toEqual(["how-it-works"]);
  });

  it("drops empty observations (no title, narrative, facts, concepts)", () => {
    const xml = `<observation>
      <type>discovery</type>
    </observation>
    <observation>
      <type>discovery</type>
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
      <request>Fix login bug</request>
      <investigated>Token validation</investigated>
      <learned>Tokens have whitespace</learned>
      <completed>Trim before use</completed>
      <next_steps>Add tests</next_steps>
      <notes>Edge case</notes>
    </summary>`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.summary).not.toBeNull();
    expect(result.summary!.request).toBe("Fix login bug");
    expect(result.summary!.next_steps).toBe("Add tests");
  });

  it("parses a skip_summary as a valid empty response", () => {
    const xml = `<skip_summary reason="trivial" />`;
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations).toHaveLength(0);
    expect(result.summary).not.toBeNull();
    expect(result.summary!.skipped).toBe(true);
    expect(result.summary!.skip_reason).toBe("trivial");
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
    const xml = "```xml\n<observation>\n<type>bugfix</type>\n<title>fenced</title>\n</observation>\n```";
    const result = parseAgentXml(xml);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.observations[0]!.title).toBe("fenced");
  });
});
