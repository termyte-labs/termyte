export interface RankedListItem {
  docId: string;
  rawScore?: number;
}

export interface RankedList {
  source: string;
  weight: number;
  items: RankedListItem[];
}

export interface FusedCandidate {
  docId: string;
  score: number;
  sources: Array<{
    source: string;
    rank: number;
    rawScore?: number;
  }>;
}

export function rrf(rank: number, k = 60): number {
  if (!Number.isFinite(rank) || rank < 1) {
    throw new Error(`RRF rank must be a positive finite number, got ${rank}`);
  }
  return 1 / (k + rank);
}

export function reciprocalRankFusion(lists: RankedList[], k = 60): FusedCandidate[] {
  const fused = new Map<string, FusedCandidate>();

  for (const list of lists) {
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!;
      const rank = i + 1;
      const existing = fused.get(item.docId) ?? {
        docId: item.docId,
        score: 0,
        sources: [],
      };

      existing.score += list.weight * rrf(rank, k);
      existing.sources.push({
        source: list.source,
        rank,
        rawScore: item.rawScore,
      });
      fused.set(item.docId, existing);
    }
  }

  return [...fused.values()].sort((a, b) => {
    const byScore = b.score - a.score;
    return byScore !== 0 ? byScore : a.docId.localeCompare(b.docId);
  });
}
