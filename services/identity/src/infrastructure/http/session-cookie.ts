import fastifyCookie from '@fastify/cookie';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** Cookie that carries the refresh token (ADR-0007): the only transport, never in a body. */
export const SESSION_COOKIE = 'inv_rt';
/** Restricts the cookie to the session endpoints. */
export const SESSION_COOKIE_PATH = '/auth';

export interface SessionCookieSettings {
  readonly secure: boolean;
  readonly maxAgeSeconds: number;
}

/** Registers the Fastify cookie plugin; call it once right after creating the application. */
export async function registerSessionCookies(app: NestFastifyApplication): Promise<void> {
  await app.register(fastifyCookie);
}

/** Reads the refresh token from the request cookie, or undefined when absent or empty. */
export function readSessionCookie(request: FastifyRequest): string | undefined {
  const value = request.cookies?.[SESSION_COOKIE];
  return value ? value : undefined;
}

/** Sets the refresh cookie: HttpOnly, SameSite=Strict, Path=/auth and Secure by configuration. */
export function setSessionCookie(
  reply: FastifyReply,
  refreshToken: string,
  settings: SessionCookieSettings,
): void {
  void reply.setCookie(SESSION_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'strict',
    path: SESSION_COOKIE_PATH,
    secure: settings.secure,
    maxAge: settings.maxAgeSeconds,
  });
}

/** Expires the refresh cookie in the browser. */
export function clearSessionCookie(reply: FastifyReply, settings: SessionCookieSettings): void {
  void reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    path: SESSION_COOKIE_PATH,
    secure: settings.secure,
  });
}
