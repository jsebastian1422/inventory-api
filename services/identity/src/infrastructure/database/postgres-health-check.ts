import type { Pool } from 'pg';
import type { DatabaseHealthCheck } from '../../domain/health/database-health-check.js';

export class PostgresHealthCheck implements DatabaseHealthCheck {
  constructor(private readonly pool: Pool) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
