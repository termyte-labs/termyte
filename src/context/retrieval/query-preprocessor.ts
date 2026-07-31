/**
 * Query preprocessor for FTS5 search.
 *
 * Applies Porter stemming, synonym expansion, and CJK-aware tokenization
 * to natural-language queries before they hit the FTS5 index.
 *
 * Strategy: since FTS5's unicode61 tokenizer does NOT stem the indexed
 * content, we use PREFIX queries (`"stem"*`) so a stemmed query term
 * matches any indexed word that shares the stem prefix. Synonyms are
 * also stemmed and prefix-queried.
 */

import { stem } from "./stemmer.js";
import { getSynonyms } from "./synonyms.js";

export interface ProcessedTerm {
  original: string;
  stem: string;
  synonyms: string[];
}

const CJK_RANGE = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
const TOKEN_PATTERN = /[\p{L}\p{N}_.:/\\-]+/gu;
const QUESTION_STOP_WORDS = new Set([
  "a", "an", "and", "are", "be", "did", "do", "does", "for", "how", "if", "in",
  "is", "of", "on", "should", "the", "to", "what", "when", "which", "with",
]);

export function preprocessQuery(query: string): {
  terms: ProcessedTerm[];
  ftsQuery: string;
} {
  const normalized = query.normalize("NFKC").trim();
  if (!normalized) return { terms: [], ftsQuery: "" };

  const rawTokens = normalized.match(TOKEN_PATTERN) ?? [];
  const terms: ProcessedTerm[] = [];
  const ftsParts: string[] = [];

  for (const token of rawTokens) {
    if (token.length < 2) continue;

    if (CJK_RANGE.test(token)) {
      const segments = segmentCjk(token);
      for (const seg of segments) {
        if (seg.length < 2) continue;
        const s = stem(seg.toLowerCase());
        const syns = getSynonyms(s);
        terms.push({ original: seg, stem: s, synonyms: syns });
        ftsParts.push(`"${escapeFts(seg.toLowerCase())}"*`);
        if (s !== seg.toLowerCase()) ftsParts.push(`"${escapeFts(s)}"*`);
        for (const syn of syns) {
          ftsParts.push(`"${escapeFts(syn)}"*`);
        }
      }
      continue;
    }

    const lower = token.toLowerCase().replaceAll("\\", "/");
    if (QUESTION_STOP_WORDS.has(lower)) continue;
    const s = stem(lower);
    const syns = getSynonyms(s);
    terms.push({ original: token, stem: s, synonyms: syns });

    ftsParts.push(`"${escapeFts(lower)}"*`);
    if (s !== lower) ftsParts.push(`"${escapeFts(s)}"*`);
    for (const syn of syns) {
      ftsParts.push(`"${escapeFts(syn)}"*`);
    }
  }

  return { terms, ftsQuery: ftsParts.join(" OR ") };
}

function escapeFts(s: string): string {
  return s.replace(/"/g, '""');
}

/**
 * CJK segmentation: since optional deps (@node-rs/jieba, tiny-segmenter)
 * may not be installed, we use a soft-fallback that splits CJK runs
 * into 2-character bigrams. This is crude but adequate for FTS5
 * prefix matching — the synonym/ranking layers clean up noise.
 */
function segmentCjk(token: string): string[] {
  // Try dynamic import of jieba for Chinese
  // (optional dependency — not imported statically to avoid build deps)
  // For now, use bigram segmentation as a universal fallback.
  const segments: string[] = [];
  const chars = [...token];
  if (chars.length <= 2) {
    return [token];
  }
  for (let i = 0; i < chars.length - 1; i++) {
    segments.push(chars[i] + chars[i + 1]);
  }
  return segments;
}
