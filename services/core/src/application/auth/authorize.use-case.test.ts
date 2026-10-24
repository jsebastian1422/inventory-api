import { describe, expect, it } from 'vitest';
import type { UserAccess } from '@inventory/shared';
import { DomainError } from '../../domain/shared/errors.js';
import { AuthorizeUseCase } from './authorize.use-case.js';

const reader = (access: UserAccess | null) => ({ load: async () => access });
const user = (overrides: Partial<UserAccess> = {}): UserAccess => ({
  userId: 'u',
  roleId: 'r',
  isActive: true,
  permissions: ['establishments.read'],
  ...overrides,
});

async function kind(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error.kind : 'other';
  }
  return 'ok';
}

describe('AuthorizeUseCase', () => {
  it('grants access with the needed permission', async () => {
    const uc = new AuthorizeUseCase(reader(user()));
    expect((await uc.execute('u', ['establishments.read'])).roleId).toBe('r');
  });

  it('401 when the user does not exist or is inactive, 403 without permission', async () => {
    expect(await kind(new AuthorizeUseCase(reader(null)).execute('u', []))).toBe('unauthorized');
    expect(
      await kind(new AuthorizeUseCase(reader(user({ isActive: false }))).execute('u', [])),
    ).toBe('unauthorized');
    expect(
      await kind(new AuthorizeUseCase(reader(user())).execute('u', ['establishments.create'])),
    ).toBe('forbidden');
  });
});
