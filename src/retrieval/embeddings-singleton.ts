/**
 * Process-level singleton for the LocalEmbeddingsProvider.
 *
 * The first embed call loads the ONNX model from disk (~130 MB
 * download on first use, 200–500 ms on warm disk). Without a
 * singleton, every hook invocation constructs a new provider and
 * triggers a fresh load. For a 200-tool-call session that's 60+
 * seconds of pure waste.
 *
 * The wrapper enforces a 2 s readiness timeout. If the model isn't
 * warm by then, the caller gets a NotReadyError and should fall
 * back to FTS-only. This is critical: the agent's hook timeouts
 * (30 s for PreToolUse, 60 s for SessionStart) must not be eaten
 * by model loading.
 */
import { LocalEmbeddingsProvider, type LocalModelId } from "./local-embeddings.js";
import { NoOpEmbeddingsProvider } from "./embeddings.js";
import type { EmbeddingsProvider } from "./embeddings.js";

const READINESS_TIMEOUT_MS = 2_000;

export class EmbeddingsNotReadyError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`local embedding model not ready within ${timeoutMs}ms`);
    this.name = "EmbeddingsNotReadyError";
  }
}

interface CachedProvider {
  provider: EmbeddingsProvider;
  /** Resolves when the model is loaded and warm. */
  ready: Promise<void>;
  /** Resolves with true when ready, false when not (e.g. load failed). */
  resolved: Promise<boolean>;
}

let cached: CachedProvider | null = null;

/** Test-only: clear the singleton. */
export function _resetEmbeddingsForTest(): void { cached = null; }

/** Get the process-level singleton, warming it in the background. */
export function getEmbeddings(model: LocalModelId = "nomic-embed"): CachedProvider {
  if (cached) return cached;

  const provider = new LocalEmbeddingsProvider({ model });
  const noop = new NoOpEmbeddingsProvider();

  // The LocalEmbeddingsProvider constructor kicks off `init()`
  // internally and exposes `ready` as a Promise. We race it against
  // the readiness timeout. On timeout we swap to NoOp so the
  // hook returns quickly; subsequent calls will retry the real
  // provider.
  let resolved = false;
  const resolvedPromise = new Promise<boolean>((resolve) => {
    // @ts-expect-error - ready is private but we know it exists
    const ready: Promise<void> = provider.ready;
    if (!ready) { resolve(false); return; }
    Promise.race([
      ready.then(() => { resolved = true; resolve(true); }),
      new Promise<false>((r) => setTimeout(() => r(false), READINESS_TIMEOUT_MS)),
    ]).catch(() => resolve(false));
  });

  cached = {
    provider: new Proxy(provider, {
      get(target, prop) {
        if (!resolved && prop === "embed") {
          // Return a function that throws NotReadyError if the
          // caller races past readiness. Most callers will await
          // `getEmbeddings().ready` first.
          return async () => { throw new EmbeddingsNotReadyError(READINESS_TIMEOUT_MS); };
        }
        return Reflect.get(target, prop);
      },
    }) as EmbeddingsProvider,
    ready: resolvedPromise.then(() => undefined),
    resolved: resolvedPromise,
  };
  // After timeout, swap to noop so subsequent calls return fast.
  resolvedPromise.then((ok) => {
    if (!ok) cached!.provider = noop;
  });
  return cached;
}

/** Returns the singleton, or null if it has never been initialized. */
export function getCachedEmbeddings(): CachedProvider | null {
  return cached;
}
