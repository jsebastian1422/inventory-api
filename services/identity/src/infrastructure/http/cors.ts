import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Enables CORS for the exact origins listed (no wildcard). Credentials are allowed so the browser
 * sends the session cookie to /auth/*. No-op when the list is empty.
 */
export function configureCors(app: NestFastifyApplication, origins: readonly string[]): void {
  if (origins.length === 0) return;
  app.enableCors({
    origin: [...origins],
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      'X-Requested-With',
    ],
    exposedHeaders: ['Retry-After'],
    credentials: true,
    maxAge: 600,
  });
}
