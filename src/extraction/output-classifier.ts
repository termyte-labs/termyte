import type { ObserverOutputClass } from "../types.js";

const OBSERVATION_KEYWORDS = [
  "observation", "discovery", "bugfix", "refactor", "optimization",
  "decision", "test", "documentation", "configuration", "dependency",
  "security", "performance", "architecture", "investigation",
];

const SUMMARY_KEYWORDS = ["summary", "request", "investigated", "learned", "completed", "next_steps"];

const POISONED_PATTERNS = [
  /system\s*(prompt|message|instruction)/i,
  /ignore\s*(previous|above|all|prior)/i,
  /you\s*are\s*(a|an)\s*(assistant|AI|model)/i,
  /pretend\s*(you|to|that)/i,
  /act\s*as\s*(if|a|an)/i,
  /forget\s*(everything|all|previous)/i,
  /new\s*(instructions|rules|system)/i,
  /override\s*(previous|all|above)/i,
  /<!-\-[\s\S]*?-->/,
  /<script[\s>]/i,
];

export function classifyOutput(text: string): ObserverOutputClass {
  if (!text || text.trim().length === 0) {
    return "idle";
  }

  const trimmed = text.trim();

  for (const pattern of POISONED_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "poisoned";
    }
  }

  const hasObsTag = /<observations>[\s\S]*?<\/observations>/i.test(trimmed);
  const hasSummaryTag = /<summary>[\s\S]*?<\/summary>/i.test(trimmed);

  if (hasObsTag || hasSummaryTag) {
    return "xml";
  }

  const lowerText = trimmed.toLowerCase();
  const hasObsKeywords = OBSERVATION_KEYWORDS.some((kw) => lowerText.includes(kw));
  const hasSumKeywords = SUMMARY_KEYWORDS.some((kw) => lowerText.includes(kw));

  if (hasObsKeywords || hasSumKeywords) {
    const lineCount = trimmed.split("\n").length;
    const wordCount = trimmed.split(/\s+/).length;
    if (lineCount > 3 && wordCount > 20) {
      return "prose";
    }
  }

  if (trimmed.length < 50 && (trimmed.includes("[]") || trimmed.includes("{}") || trimmed.includes("OK"))) {
    return "idle";
  }

  return "prose";
}
