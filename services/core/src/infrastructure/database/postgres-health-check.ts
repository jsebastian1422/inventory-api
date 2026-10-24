import { Pool } from 'pg';
import type { DatabaseHealthCheck } from '../../domain/health/database-health-check.js';
import type { AppConfig } from '../config/config.js';

export class PostgresHealthCheck implements DatabaseHealthCheck {
  private readonly pool: Pool;

  constructor(config: AppConfig) {
    this.pool = new Pool({
      host: config.POSTGRES_HOST,
      port: config.POSTGRES_PORT,
      user: config.POSTGRES_USER,
      password: config.POSTGRES_PASSWORD,
      database: config.POSTGRES_DB,
      max: 2,
      connectionTimeoutMillis: 2000,
    });
    // Idle client errors (e.g. DB stopped) must not crash the process.
    this.pool.on('error', () => undefined);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
