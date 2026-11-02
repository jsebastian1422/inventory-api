import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { forbiddenError } from '../../domain/shared/errors.js';
import type { IdentityConfig } from '../config/config.js';
import { APP_CONFIG } from './tokens.js';

/** Value the web app sends in `X-Requested-With`; a custom header forces a CORS preflight. */
export const CSRF_HEADER_VALUE = 'inventory-web';

/**
 * CSRF defence for the endpoints that read the session cookie (ADR-0007): the request must come
 * from an allowed origin (`CORS_ORIGINS`) and carry `X-Requested-With: inventory-web`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: IdentityConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const origin = request.headers.origin;
    const marker = request.headers['x-requested-with'];
    const originAllowed = typeof origin === 'string' && this.config.corsOrigins.includes(origin);
    if (!originAllowed || marker !== CSRF_HEADER_VALUE) {
      throw forbiddenError('Solicitud rechazada', 'CSRF_REJECTED');
    }
    return true;
  }
}
