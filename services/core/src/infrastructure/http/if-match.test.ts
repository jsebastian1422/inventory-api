import { describe, expect, it } from 'vitest';
import { DomainError } from '../../domain/shared/errors.js';
import { parseIfMatch } from './if-match.js';

describe('parseIfMatch', () => {
  it('returns undefined when absent and the number for quoted or bare versions', () => {
    expect(parseIfMatch(undefined)).toBeUndefined();
    expect(parseIfMatch('"3"')).toBe(3);
    expect(parseIfMatch('3')).toBe(3);
    expect(parseIfMatch(' "12" ')).toBe(12);
  });

  it.each(['*', '0', '"0"', '-1', '1.5', 'abc', '"3', 'W/"3"', '"1","2"', '', '2147483648'])(
    'rejects %j with a 400 on field If-Match',
    (value) => {
      try {
        parseIfMatch(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).details?.[0]?.field).toBe('If-Match');
      }
    },
  );

  it('rejects repeated headers', () => {
    expect(() => parseIfMatch(['1', '2'])).toThrow(DomainError);
  });
});
