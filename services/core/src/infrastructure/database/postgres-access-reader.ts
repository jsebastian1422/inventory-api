import type { Pool } from 'pg';
import {
  toUserAccess,
  USER_ACCESS_QUERY,
  type UserAccess,
  type UserAccessRow,
} from '@inventory/shared';
import type { AccessReader } from '../../domain/auth/access-reader.js';

/** Read-only: runs the shared USER_ACCESS_QUERY over identity tables (ADR-0001). */
export class PostgresAccessReader implements AccessReader {
  constructor(private readonly pool: Pool) {}

  async load(userId: string): Promise<UserAccess | null> {
    const { rows } = await this.pool.query<UserAccessRow>(USER_ACCESS_QUERY, [userId]);
    const row = rows[0];
    return row ? toUserAccess(row) : null;
  }
}
