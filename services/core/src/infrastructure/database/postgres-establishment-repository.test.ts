import { describe, expect, it } from 'vitest';
import { escapeLike } from './postgres-establishment-repository.js';

describe('escapeLike', () => {
  it('escapes LIKE wildcards and the escape character', () => {
    expect(escapeLike('50%_off\\')).toBe('50\\%\\_off\\\\');
    expect(escapeLike('plain')).toBe('plain');
  });
});
