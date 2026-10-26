import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import { assertInScope, hasFullAccess } from './scope.js';

const scope = { access: 'assigned', ids: ['a'] } as const;

function failure(run: () => void): DomainError {
  try {
    run();
  } catch (error) {
    return error as DomainError;
  }
  throw new Error('did not throw');
}

describe('assertInScope (R-5)', () => {
  it('missing establishment -> 404', () => {
    expect(failure(() => assertInScope(null, scope)).kind).toBe('not_found');
  });

  it('inactive establishment -> 409 ESTABLISHMENT_INACTIVE, even when assigned', () => {
    const error = failure(() => assertInScope({ id: 'a', isActive: false }, scope));
    expect(error).toMatchObject({ kind: 'conflict', code: 'ESTABLISHMENT_INACTIVE' });
  });

  it('outside the scope -> 403 ESTABLISHMENT_NOT_IN_SCOPE', () => {
    const error = failure(() => assertInScope({ id: 'b', isActive: true }, scope));
    expect(error).toMatchObject({ kind: 'forbidden', code: 'ESTABLISHMENT_NOT_IN_SCOPE' });
  });

  it('inside the scope passes', () => {
    expect(() => assertInScope({ id: 'a', isActive: true }, scope)).not.toThrow();
  });
});

describe('hasFullAccess', () => {
  it('depends only on establishments.all', () => {
    expect(hasFullAccess({ userId: 'u', permissions: ['establishments.all'] })).toBe(true);
    expect(hasFullAccess({ userId: 'u', permissions: ['stock.search'] })).toBe(false);
  });
});
