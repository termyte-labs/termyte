import type { BenchmarkDataset } from "../types.js";

const TOPICS = [
  ["authentication middleware JWT", "Auth middleware validates JWT bearer tokens before protected requests."],
  ["PostgreSQL connection pooling", "PostgreSQL uses a bounded connection pool with timeout handling."],
  ["Kubernetes pod crash", "Kubernetes pod crashes are diagnosed with previous logs and readiness events."],
  ["rate limiting API", "The API rate limiter uses a token bucket keyed by account."],
  ["Playwright end to end tests", "Playwright end to end tests reset fixtures before each scenario."],
  ["Docker multi stage build", "The Docker image uses a multi stage build and a minimal runtime layer."],
  ["Redis caching layer", "Redis cache entries use versioned keys and bounded TTL values."],
  ["GitHub Actions deployment", "GitHub Actions deploys only after tests and package validation pass."],
  ["Prisma migration drift", "Prisma migration drift is checked against a disposable shadow database."],
  ["Datadog monitoring alerts", "Datadog alerts group failures by service and deployment version."],
] as const;

export function generateScaleDataset(count: number, seed = 42): BenchmarkDataset {
  if (!Number.isInteger(count) || count < TOPICS.length) {
    throw new Error(`Scale size must be an integer >= ${TOPICS.length}.`);
  }
  const random = xorshift(seed);
  const documents = Array.from({ length: count }, (_, index) => {
    const topicIndex = index % TOPICS.length;
    const topic = TOPICS[topicIndex]!;
    const nonce = Math.floor(random() * 1_000_000);
    return {
      id: `scale-${index}`,
      title: `${topic[0]} incident ${index}`,
      content: `${topic[1]} Incident ${index} used runbook marker ${nonce}.`,
      metadata: { synthetic: true, topic: topicIndex },
    };
  });
  const queries = TOPICS.map((topic, index) => ({
    id: `topic-${index}`,
    query: `${topic[0]} runbook marker ${documents[index]!.content.match(/marker (\d+)/)?.[1] ?? ""}`,
    relevantDocumentIds: [documents[index]!.id],
  }));
  return { name: `Termyte deterministic scale ${count}`, version: `seed-${seed}`, suite: "scale", documents, queries };
}

function xorshift(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}
