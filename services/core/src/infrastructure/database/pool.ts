import { Pool } from 'pg';
import type { AppConfig } from '../config/config.js';

/** Pool shared by the business adapters (the health check keeps its own small pool). */
export function createPool(config: AppConfig): Pool {
  const pool = new Pool({
    host: config.POSTGRES_HOST,
    port: config.POSTGRES_PORT,
    user: config.POSTGRES_USER,
    password: config.POSTGRES_PASSWORD,
    database: config.POSTGRES_DB,
    max: 10,
    connectionTimeoutMillis: 2000,
  });
  // Idle client errors (e.g. DB stopped) must not crash the process.
  pool.on('error', () => undefined);
  return pool;
}

export function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === code;
}

export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';

/** Name of the violated constraint of a PostgreSQL error, when it carries one. */
export function violatedConstraint(error: unknown): string | undefined {
  return (error as { constraint?: string } | null)?.constraint;
}
