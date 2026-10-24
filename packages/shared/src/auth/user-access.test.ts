import { describe, expect, it } from 'vitest';
import { AccessDeniedError, assertAccess, toUserAccess, type UserAccess } from './user-access.js';

const access = (overrides: Partial<UserAccess> = {}): UserAccess => ({
  userId: 'u1',
  roleId: 'r1',
  isActive: true,
  permissions: ['establishments.read'],
  ...overrides,
});

const kindOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof AccessDeniedError ? error.kind : 'other';
  }
  return 'none';
};

describe('assertAccess', () => {
  it('returns the access when active and holding every required permission', () => {
    expect(assertAccess(access(), ['establishments.read'])).toEqual(access());
    expect(assertAccess(access(), [])).toEqual(access());
  });

  it('is unauthorized when the user does not exist', () => {
    expect(kindOf(() => assertAccess(null, []))).toBe('unauthorized');
  });

  it('is unauthorized when the user is inactive', () => {
    expect(kindOf(() => assertAccess(access({ isActive: false }), []))).toBe('unauthorized');
  });

  it('is forbidden when a permission is missing', () => {
    expect(kindOf(() => assertAccess(access(), ['establishments.create']))).toBe('forbidden');
    expect(
      kindOf(() => assertAccess(access(), ['establishments.read', 'establishments.create'])),
    ).toBe('forbidden');
  });
});

describe('toUserAccess', () => {
  it('maps a query row', () => {
    expect(toUserAccess({ id: 'u', role_id: 'r', is_active: false, permissions: ['a.b'] })).toEqual(
      { userId: 'u', roleId: 'r', isActive: false, permissions: ['a.b'] },
    );
  });
});
