/**
 * Token-bucket rate limiter. Each adapter that needs rate limiting
 * (e.g. Gemini free tier: 60 req/min, 1000 req/day) creates one.
 *
 * The bucket is in-memory only — the limiter is reset on process
 * restart. A persistent counter belongs in `termyte stats` instead.
 */

export interface RateLimitConfig {
  /** Max requests per windowMs. */
  maxRequests: number;
  /** Window length in ms. */
  windowMs: number;
}

export class RateLimiter {
  private timestamps: number[] = [];
  constructor(private config: RateLimitConfig) {}

  /** Record a hit. Returns true if the request is allowed under the
   *  rate limit, false if the caller should back off. */
  tryAcquire(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.timestamps.length >= this.config.maxRequests) return false;
    this.timestamps.push(now);
    return true;
  }

  /** How many slots remain right now. */
  remaining(now: number = Date.now()): number {
    this.prune(now);
    return Math.max(0, this.config.maxRequests - this.timestamps.length);
  }

  /** How many ms until the next slot opens. 0 if a slot is available now. */
  msUntilNext(now: number = Date.now()): number {
    this.prune(now);
    if (this.timestamps.length < this.config.maxRequests) return 0;
    return Math.max(0, this.timestamps[0]! + this.config.windowMs - now);
  }

  private prune(now: number): void {
    const cutoff = now - this.config.windowMs;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
  }
}
