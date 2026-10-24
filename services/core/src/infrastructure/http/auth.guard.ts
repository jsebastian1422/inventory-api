import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InvalidAccessTokenError, verifyAccessToken } from '@inventory/shared';
import type { AuthorizeUseCase } from '../../application/auth/authorize.use-case.js';
import { unauthorizedError } from '../../domain/shared/errors.js';
import type { AppConfig } from '../config/config.js';
import { IS_PUBLIC_KEY, PERMISSIONS_KEY, type AuthenticatedRequest } from './auth-decorators.js';
import { APP_CONFIG, AUTHORIZE_USE_CASE } from './tokens.js';

/**
 * Global guard. 1) verifies the JWT signature/expiry with the shared verifier, 2) checks in the
 * database that the user is still active and holds the required permissions (effective at once).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(AUTHORIZE_USE_CASE) private readonly authorize: AuthorizeUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (\S+)$/.exec(header) : null;
    if (!match) throw unauthorizedError('Se requiere autenticación');

    let userId: string;
    try {
      userId = (await verifyAccessToken(match[1]!, this.config.publicKeyPem)).userId;
    } catch (error) {
      if (error instanceof InvalidAccessTokenError) {
        throw unauthorizedError('Credencial inválida o expirada', 'INVALID_TOKEN');
      }
      throw error;
    }

    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const access = await this.authorize.execute(userId, required);
    request.auth = { userId, roleId: access.roleId, permissions: access.permissions };
    return true;
  }
}
