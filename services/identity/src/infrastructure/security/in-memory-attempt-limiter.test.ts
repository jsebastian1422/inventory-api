import { describe, expect, it } from 'vitest';
import { InMemoryAttemptLimiter } from './in-memory-attempt-limiter.js';

describe('InMemoryAttemptLimiter', () => {
  it('limits after max attempts, reports Retry-After and frees the slot as the window slides', () => {
    let clock = 1_000_000;
    const limiter = new InMemoryAttemptLimiter(() => clock);
    limiter.record('k', 60);
    clock += 10_000;
    limiter.record('k', 60);
    expect(limiter.retryAfter('k', 2, 60)).toBe(50);
    clock += 40_000;
    expect(limiter.retryAfter('k', 2, 60)).toBe(10);
    clock += 10_000;
    expect(limiter.retryAfter('k', 2, 60)).toBe(0);
  });

  it('keeps keys independent and reset clears one key', () => {
    const limiter = new InMemoryAttemptLimiter(() => 0);
    limiter.record('a', 60);
    limiter.record('b', 60);
    expect(limiter.retryAfter('a', 1, 60)).toBe(60);
    limiter.reset('a');
    expect(limiter.retryAfter('a', 1, 60)).toBe(0);
    expect(limiter.retryAfter('b', 1, 60)).toBe(60);
  });
});
