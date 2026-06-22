import type { ASTAnchor } from "../types.js";
import { extractAnchors } from "./index.js";
import fs from "node:fs";

export async function extractAnchorsFromFile(filePath: string): Promise<ASTAnchor[]> {
  try {
    const sourceCode = fs.readFileSync(filePath, "utf-8");
    return extractAnchors(filePath, sourceCode);
  } catch {
    return [];
  }
}

export async function extractAnchorsFromDiff(
  filePath: string,
  diffContent: string,
): Promise<ASTAnchor[]> {
  const addedLines: string[] = [];
  for (const line of diffContent.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      addedLines.push(line.slice(1));
    }
  }
  if (addedLines.length === 0) return [];
  const syntheticSource = addedLines.join("\n");
  return extractAnchors(filePath, syntheticSource);
}
