import { describe, expect, it } from 'vitest';
import {
  type Actor,
  assertCanGrant,
  assertNotOwnRole,
  isSubset,
  missingPermissions,
} from './shared/privilege-rules.js';

const actor: Actor = { id: 'u1', roleId: 'r1', permissions: ['users.read', 'users.update'] };

describe('privilege rules', () => {
  it('computes subsets and missing permissions', () => {
    expect(isSubset([], ['a'])).toBe(true);
    expect(isSubset(['a', 'a'], ['a', 'b'])).toBe(true);
    expect(isSubset(['a', 'c'], ['a', 'b'])).toBe(false);
    expect(missingPermissions(['a'], ['c', 'b', 'a', 'b'])).toEqual(['b', 'c']);
  });

  it('allows granting a subset of the actor permissions, including the empty set', () => {
    expect(() => assertCanGrant(actor, [], 'x')).not.toThrow();
    expect(() => assertCanGrant(actor, ['users.read'], 'x')).not.toThrow();
    expect(() => assertCanGrant(actor, ['users.update', 'users.read'], 'x')).not.toThrow();
  });

  it('denies granting a permission the actor lacks with 403 PRIVILEGE_ESCALATION', () => {
    expect(() => assertCanGrant(actor, ['users.read', 'roles.update'], 'asignar ese rol')).toThrow(
      expect.objectContaining({
        kind: 'forbidden',
        code: 'PRIVILEGE_ESCALATION',
        message: expect.stringContaining('asignar ese rol'),
      }),
    );
  });

  it('denies touching the own role only', () => {
    expect(() => assertNotOwnRole(actor, 'r2')).not.toThrow();
    expect(() => assertNotOwnRole(actor, 'r1')).toThrow(
      expect.objectContaining({ kind: 'forbidden', code: 'PRIVILEGE_ESCALATION' }),
    );
  });
});
