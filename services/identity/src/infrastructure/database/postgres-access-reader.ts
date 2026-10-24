import type { Pool } from 'pg';
import { toUserAccess, USER_ACCESS_QUERY, type UserAccessRow } from '@inventory/shared';
import type { AccessReader, UserAccess } from '../../domain/auth/ports.js';

/** One query per protected request: user status and the live permissions of their role. */
export class PostgresAccessReader implements AccessReader {
  constructor(private readonly pool: Pool) {}

  async load(userId: string): Promise<UserAccess | null> {
    const { rows } = await this.pool.query<UserAccessRow>(USER_ACCESS_QUERY, [userId]);
    const row = rows[0];
    return row ? toUserAccess(row) : null;
  }
}
