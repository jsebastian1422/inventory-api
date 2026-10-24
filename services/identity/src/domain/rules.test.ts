import { describe, expect, it } from 'vitest';
import { assertNotLastActiveAdmin } from './user/admin-rules.js';
import { assertPasswordPolicy } from './user/password-policy.js';
import {
  assertCanChangePermissions,
  assertCanDeleteRole,
  assertCanRename,
} from './role/role-rules.js';
import { normalizeEmail } from './shared/email.js';
import { DomainError } from './shared/errors.js';
import type { Role } from './role/role.js';
import type { User } from './user/user.js';

const user = (isSystem: boolean, isActive = true): User => ({
  id: 'u1',
  email: 'a@b.co',
  fullName: 'A',
  role: { id: 'r1', name: 'X', isSystem },
  isActive,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const role = (isSystem: boolean): Role => ({
  id: 'r1',
  name: 'Administrador',
  description: '',
  isSystem,
  permissions: [],
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('password policy', () => {
  it('accepts a valid password', () => {
    expect(() => assertPasswordPolicy('abc12345')).not.toThrow();
  });
  it.each(['short1', 'onlyletters', '12345678'])('rejects %s', (pwd) => {
    expect(() => assertPasswordPolicy(pwd)).toThrow(DomainError);
  });
});

describe('normalizeEmail', () => {
  it('trims and lower-cases', () => {
    expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
  });
  it('rejects invalid formats', () => {
    expect(() => normalizeEmail('no-at-sign')).toThrow(DomainError);
  });
});

describe('last administrator rule', () => {
  it('blocks the only active system-role user', () => {
    expect(() => assertNotLastActiveAdmin(user(true), 0, 'desactivar al')).toThrowError(
      /último administrador/,
    );
  });
  it('allows when another active administrator exists', () => {
    expect(() => assertNotLastActiveAdmin(user(true), 1, 'desactivar al')).not.toThrow();
  });
  it('allows non-administrators', () => {
    expect(() => assertNotLastActiveAdmin(user(false), 0, 'desactivar al')).not.toThrow();
  });
});

describe('role rules', () => {
  it('protects the system role', () => {
    expect(() => assertCanDeleteRole(role(true), 0)).toThrow(DomainError);
    expect(() => assertCanChangePermissions(role(true))).toThrow(DomainError);
    expect(() => assertCanRename(role(true), 'Otro')).toThrow(DomainError);
  });
  it('refuses to delete a role in use', () => {
    expect(() => assertCanDeleteRole(role(false), 2)).toThrowError(/usuarios asignados/);
    expect(() => assertCanDeleteRole(role(false), 0)).not.toThrow();
  });
});
