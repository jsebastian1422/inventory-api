import type { AttemptLimiter } from '../../domain/auth/ports.js';

const SWEEP_EVERY = 500;

/**
 * Sliding window per key, kept in process memory. It restarts with the process and is not shared
 * between instances (identity runs as one instance; replace the adapter if that changes).
 */
export class InMemoryAttemptLimiter implements AttemptLimiter {
  private readonly attempts = new Map<string, number[]>();
  private recorded = 0;
  private longestWindowSeconds = 0;

  constructor(private readonly now: () => number = Date.now) {}

  retryAfter(key: string, max: number, windowSeconds: number): number {
    const live = this.live(key, windowSeconds);
    if (live.length < max) return 0;
    // The window frees a slot when the (length - max + 1)-th oldest attempt expires.
    const blocking = live[live.length - max]!;
    return Math.max(1, Math.ceil((blocking + windowSeconds * 1000 - this.now()) / 1000));
  }

  record(key: string, windowSeconds: number): void {
    this.longestWindowSeconds = Math.max(this.longestWindowSeconds, windowSeconds);
    const live = this.live(key, windowSeconds);
    live.push(this.now());
    this.attempts.set(key, live);
    if (++this.recorded % SWEEP_EVERY === 0) this.sweep();
  }

  reset(key: string): void {
    this.attempts.delete(key);
  }

  private live(key: string, windowSeconds: number): number[] {
    const limit = this.now() - windowSeconds * 1000;
    return (this.attempts.get(key) ?? []).filter((at) => at > limit);
  }

  /** Drops keys whose attempts have all expired so random keys cannot grow the map forever. */
  private sweep(): void {
    for (const key of [...this.attempts.keys()]) {
      if (this.live(key, this.longestWindowSeconds).length === 0) this.attempts.delete(key);
    }
  }
}
