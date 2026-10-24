import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Actor } from '../../domain/shared/privilege-rules.js';

export const IS_PUBLIC_KEY = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Endpoints are protected by default; this opts one out (login, health). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Requires an authenticated, active user holding ALL the listed permissions. */
export const RequirePermissions = (...codes: string[]) => SetMetadata(PERMISSIONS_KEY, codes);

export interface AuthenticatedRequest extends FastifyRequest {
  auth?: { userId: string; roleId: string; permissions: readonly string[] };
}

/** Id of the authenticated user (set by AuthGuard). */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    return ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth!.userId;
  },
);

/** Authenticated user with the permissions effective in this request (resolved by AuthGuard). */
export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const auth = ctx.switchToHttp().getRequest<AuthenticatedRequest>().auth!;
  return { id: auth.userId, roleId: auth.roleId, permissions: auth.permissions };
});
