import type { Pool } from 'pg';
import type { AccessReader, UserAccess } from '../../domain/auth/ports.js';

/** One query per protected request: user status and the live permissions of their role. */
export class PostgresAccessReader implements AccessReader {
  constructor(private readonly pool: Pool) {}

  async load(userId: string): Promise<UserAccess | null> {
    const { rows } = await this.pool.query<{
      id: string;
      role_id: string;
      is_active: boolean;
      permissions: string[];
    }>(
      `SELECT u.id, u.role_id, u.is_active,
              ARRAY(
                SELECT p.code::text FROM permissions p
                WHERE r.is_system OR EXISTS (
                  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
                )
                ORDER BY p.code
              ) AS permissions
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [userId],
    );
    const row = rows[0];
    return row
      ? {
          userId: row.id,
          roleId: row.role_id,
          isActive: row.is_active,
          permissions: row.permissions,
        }
      : null;
  }
}
