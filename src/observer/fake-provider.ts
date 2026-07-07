import { existsSync, writeFileSync } from "node:fs";
import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from "./provider.js";

/**
 * Deterministic offline LLM provider used for tests and for local
 * environments that need the full pipeline to run without a remote model.
 *
 * It produces valid XML for the three Termyte prompt shapes:
 * - trace -> observation
 * - observation -> memory consolidation
 * - session -> summary
 */
export class FakeLLMProvider implements LLMProvider {
  private static readonly failMarker = process.env.TERMYTE_FAKE_LLM_FAIL_MARKER ?? null;

  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<ChatResponse> {
    if (this.shouldFailOnce()) {
      throw new Error("FakeLLMProvider: injected failure");
    }

    const prompt = messages.map((message) => message.content).join("\n");

    if (prompt.includes("<summary>") || prompt.includes("Generate a summary of this completed agent session.")) {
      return { content: this.buildSummary(prompt), model: "fake" };
    }

    if (prompt.includes("Consolidate the following observations") || prompt.includes("<observation_summary")) {
      return { content: this.buildConsolidation(prompt), model: "fake" };
    }

    return { content: this.buildObservation(prompt), model: "fake" };
  }

  private shouldFailOnce(): boolean {
    if (process.env.TERMYTE_FAKE_LLM_FAIL_ONCE !== "1") return false;
    const marker = FakeLLMProvider.failMarker;
    if (!marker) return false;
    try {
      if (existsSync(marker)) return false;
      writeFileSync(marker, "failed-once", "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  private buildObservation(prompt: string): string {
    const tool = extractTag(prompt, "tool") ?? "tool";
    const input = extractTag(prompt, "input");
    const output = extractTag(prompt, "output");
    const cwd = extractTag(prompt, "directory");
    const command = parseCommand(input);
    const filePath = parseFilePath(input) ?? parseFilePath(output);

    const type = /(?:test|build|lint|fix|install|validate)/i.test(command ?? "")
      ? "procedure"
      : filePath
        ? "fact"
        : "procedure";
    const title = command
      ? `Ran ${command}`
      : filePath
        ? `Inspected ${filePath}`
        : `Observed ${tool}`;
    const description = [
      command ? `Executed ${command}.` : `Observed a ${tool} execution.`,
      cwd ? `Workspace: ${cwd}.` : null,
      filePath ? `Evidence references ${filePath}.` : null,
    ].filter(Boolean).join(" ");

    return buildObservationXml({
      type,
      title,
      description,
      filesRead: filePath ? [filePath] : [],
      filesModified: command && /(?:fix|update|edit|write|patch)/i.test(command) ? [filePath ?? "src/index.ts"] : [],
    });
  }

  private buildConsolidation(prompt: string): string {
    const observationTitles = [...prompt.matchAll(/<title>([\s\S]*?)<\/title>/g)]
      .map((match) => match[1]!.trim())
      .filter(Boolean);
    const firstTitle = observationTitles[0] ?? "deterministic offline memory";
    const files = [...prompt.matchAll(/<files_(?:read|modified)>([\s\S]*?)<\/files_(?:read|modified)>/g)]
      .flatMap((match) => match[1]!.split(",").map((part) => part.trim()).filter(Boolean));

    return buildObservationXml({
      type: "fact",
      title: `Consolidated: ${firstTitle}`,
      description: `Offline consolidation preserved the durable signal from ${firstTitle}.`,
      filesRead: files.filter((file) => file.length > 0),
      filesModified: [],
    });
  }

  private buildSummary(prompt: string): string {
    const files = [...prompt.matchAll(/- (.+)$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
    const summaryText = files.length > 0
      ? `This offline session touched ${files.length} prompt line(s) and completed deterministic synthesis.`
      : "This offline session completed deterministic synthesis.";

    return [
      "<summary>",
      `  <summary_text>${escapeXml(summaryText)}</summary_text>`,
      "  <key_changes>",
      `    <change>${escapeXml(files[0] ?? "Captured a trace and produced durable memory.")}</change>`,
      "  </key_changes>",
      "  <key_learnings>",
      "    <learning>Deterministic offline synthesis can still produce usable memory.</learning>",
      "  </key_learnings>",
      "</summary>",
    ].join("\n");
  }
}

function buildObservationXml(input: {
  type: string;
  title: string;
  description: string;
  filesRead: string[];
  filesModified: string[];
}): string {
  const lines = [
    "<observation>",
    `  <type>${escapeXml(input.type)}</type>`,
    `  <title>${escapeXml(input.title)}</title>`,
    `  <description>${escapeXml(input.description)}</description>`,
  ];

  if (input.filesRead.length > 0) {
    lines.push("  <files_read>");
    for (const file of input.filesRead) {
      lines.push(`    <file>${escapeXml(file)}</file>`);
    }
    lines.push("  </files_read>");
  }

  if (input.filesModified.length > 0) {
    lines.push("  <files_modified>");
    for (const file of input.filesModified) {
      lines.push(`    <file>${escapeXml(file)}</file>`);
    }
    lines.push("  </files_modified>");
  }

  lines.push("</observation>");
  return lines.join("\n");
}

function extractTag(prompt: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i").exec(prompt);
  if (!match) return null;
  const value = match[1]!.trim();
  return value.length > 0 ? value : null;
}

function parseCommand(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as { command?: unknown } | null;
    if (parsed && typeof parsed.command === "string" && parsed.command.trim()) {
      return parsed.command.trim();
    }
  } catch {
    // Best effort only.
  }
  return null;
}

function parseFilePath(input: string | null): string | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input) as { file_path?: unknown; path?: unknown } | null;
    if (parsed) {
      if (typeof parsed.file_path === "string" && parsed.file_path.trim()) return parsed.file_path.trim();
      if (typeof parsed.path === "string" && parsed.path.trim()) return parsed.path.trim();
    }
  } catch {
    // Best effort only.
  }
  return null;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
