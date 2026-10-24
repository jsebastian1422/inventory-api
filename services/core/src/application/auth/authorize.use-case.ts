import { AccessDeniedError, assertAccess, type UserAccess } from '@inventory/shared';
import type { AccessReader } from '../../domain/auth/access-reader.js';
import { forbiddenError, unauthorizedError } from '../../domain/shared/errors.js';

/** Guard logic: the user must still be active and hold every required permission (ADR-0001). */
export class AuthorizeUseCase {
  constructor(private readonly access: AccessReader) {}

  async execute(userId: string, required: readonly string[]): Promise<UserAccess> {
    const access = await this.access.load(userId);
    try {
      return assertAccess(access, required);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        throw error.kind === 'unauthorized'
          ? unauthorizedError('Sesión inválida o expirada', 'INVALID_SESSION')
          : forbiddenError('No tienes permiso para realizar esta acción');
      }
      throw error;
    }
  }
}
