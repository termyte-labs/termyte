import type { BenchmarkDocument, BenchmarkSearchResult, MemoryBenchmarkAdapter } from "../types.js";

export class GrepBenchmarkAdapter implements MemoryBenchmarkAdapter {
  readonly name = "grep";
  private documents: BenchmarkDocument[] = [];
  async reset(): Promise<void> { this.documents = []; }
  async ingest(documents: readonly BenchmarkDocument[]): Promise<void> { this.documents = [...documents]; }
  async search(query: string, limit: number, options: { scope?: string } = {}): Promise<BenchmarkSearchResult[]> {
    const terms = tokenize(query);
    return this.documents
      .filter((document) => !options.scope || document.scope === options.scope)
      .map((document) => ({
        documentId: document.id,
        score: terms.reduce((hits, term) => hits + (document.content.toLowerCase().includes(term) ? 1 : 0), 0),
      }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || a.documentId.localeCompare(b.documentId))
      .slice(0, limit);
  }
  async stats(): Promise<Record<string, number>> { return { documents: this.documents.length }; }
  async close(): Promise<void> { this.documents = []; }
}

function tokenize(value: string): string[] {
  return value.toLowerCase().replace(/[^a-z0-9_]+/g, " ").split(/\s+/).filter((term) => term.length > 2);
}

