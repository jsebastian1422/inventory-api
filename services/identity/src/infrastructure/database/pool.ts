import { Pool } from 'pg';
import type { DatabaseConfig } from '../config/config.js';

export function createPool(config: DatabaseConfig): Pool {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
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
