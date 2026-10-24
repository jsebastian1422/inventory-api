import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

export const IS_PUBLIC_KEY = 'auth:public';
export const PERMISSIONS_KEY = 'auth:permissions';

/** Endpoints are protected by default; this opts one out (health). */
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
