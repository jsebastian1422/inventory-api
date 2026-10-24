import { describe, expect, it } from 'vitest';
import { ROLE_NAME_MAX } from '../../domain/role/role-rules.js';
import { FULL_NAME_MAX } from '../../domain/user/user.js';
import {
  createRoleSchema,
  createUserSchema,
  updateRoleSchema,
  updateUserSchema,
} from './schemas.js';

describe('length limits single source (CA-24)', () => {
  const uid = '00000000-0000-4000-8000-000000000000';
  it('uses the domain constants', () => {
    expect(FULL_NAME_MAX).toBe(150);
    expect(ROLE_NAME_MAX).toBe(100);
  });
  it('zod accepts the limit and rejects one more', () => {
    const user = (fullName: string) =>
      createUserSchema.safeParse({ email: 'a@b.co', password: 'x', fullName, roleId: uid });
    expect(user('x'.repeat(FULL_NAME_MAX)).success).toBe(true);
    expect(user('x'.repeat(FULL_NAME_MAX + 1)).success).toBe(false);
    expect(updateUserSchema.safeParse({ fullName: 'x'.repeat(FULL_NAME_MAX + 1) }).success).toBe(
      false,
    );
    expect(createRoleSchema.safeParse({ name: 'r'.repeat(ROLE_NAME_MAX) }).success).toBe(true);
    expect(createRoleSchema.safeParse({ name: 'r'.repeat(ROLE_NAME_MAX + 1) }).success).toBe(false);
    expect(updateRoleSchema.safeParse({ name: 'r'.repeat(ROLE_NAME_MAX + 1) }).success).toBe(false);
  });
});
