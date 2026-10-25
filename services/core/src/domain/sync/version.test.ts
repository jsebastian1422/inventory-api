import { describe, expect, it } from 'vitest';
import { isValidVersion, MAX_VERSION } from './version.js';

describe('isValidVersion', () => {
  it.each([1, 2, 100, MAX_VERSION])('accepts %d', (value) => {
    expect(isValidVersion(value)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_VERSION + 1])(
    'rejects %d',
    (value) => {
      expect(isValidVersion(value)).toBe(false);
    },
  );

  it('MAX_VERSION is the largest PostgreSQL integer', () => {
    expect(MAX_VERSION).toBe(2 ** 31 - 1);
  });
});
