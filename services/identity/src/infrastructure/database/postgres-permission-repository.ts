import type { Pool } from 'pg';
import type { Permission, PermissionRepository } from '../../domain/permission/permission.js';

export class PostgresPermissionRepository implements PermissionRepository {
  constructor(private readonly pool: Pool) {}

  async listAll(): Promise<Permission[]> {
    const { rows } = await this.pool.query<Permission>(
      'SELECT id, code, module, action, description FROM permissions ORDER BY code',
    );
    return rows;
  }

  async findMissingCodes(codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const { rows } = await this.pool.query<{ code: string }>(
      'SELECT code FROM permissions WHERE code = ANY($1::text[])',
      [codes],
    );
    const found = new Set(rows.map((row) => row.code));
    return codes.filter((code) => !found.has(code));
  }
}
