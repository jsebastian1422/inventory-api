import type { Pool } from 'pg';
import type { Role } from '../../domain/role/role.js';
import type { RoleRepository } from '../../domain/role/role-repository.js';
import { conflictError } from '../../domain/shared/errors.js';
import { FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION } from './pool.js';

// A system role always holds the whole permission catalog (present and future permissions).
const SELECT_ROLE = `
  SELECT r.id, r.name, r.description, r.is_system, r.created_at, r.updated_at,
         ARRAY(
           SELECT p.code::text FROM permissions p
           WHERE r.is_system OR EXISTS (
             SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
           )
           ORDER BY p.code
         ) AS permissions
  FROM roles r`;

interface RoleRow {
  id: string;
  name: string;
  description: string;
  is_system: boolean;
  created_at: Date;
  updated_at: Date;
  permissions: string[];
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isSystem: row.is_system,
    permissions: row.permissions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    throw conflictError('Ya existe un rol con ese nombre', 'ROLE_NAME_TAKEN');
  }
  if (isPgError(error, FOREIGN_KEY_VIOLATION)) {
    throw conflictError('No se puede eliminar un rol con usuarios asignados', 'ROLE_IN_USE');
  }
  throw error;
}

export class PostgresRoleRepository implements RoleRepository {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<Role[]> {
    const { rows } = await this.pool.query<RoleRow>(`${SELECT_ROLE} ORDER BY lower(r.name)`);
    return rows.map(toRole);
  }

  async findById(id: string): Promise<Role | null> {
    const { rows } = await this.pool.query<RoleRow>(`${SELECT_ROLE} WHERE r.id = $1`, [id]);
    return rows[0] ? toRole(rows[0]) : null;
  }

  async findSystemRole(): Promise<Role | null> {
    const { rows } = await this.pool.query<RoleRow>(`${SELECT_ROLE} WHERE r.is_system LIMIT 1`);
    return rows[0] ? toRole(rows[0]) : null;
  }

  async create(data: { name: string; description: string }): Promise<Role> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        'INSERT INTO roles (name, description) VALUES ($1, $2) RETURNING id',
        [data.name, data.description],
      );
      return (await this.findById(rows[0]!.id))!;
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async update(id: string, changes: { name?: string; description?: string }): Promise<Role> {
    try {
      await this.pool.query(
        `UPDATE roles SET name = COALESCE($2, name), description = COALESCE($3, description),
                updated_at = now() WHERE id = $1`,
        [id, changes.name ?? null, changes.description ?? null],
      );
    } catch (error) {
      return mapWriteError(error);
    }
    return (await this.findById(id))!;
  }

  async delete(id: string): Promise<void> {
    try {
      await this.pool.query('DELETE FROM roles WHERE id = $1', [id]);
    } catch (error) {
      mapWriteError(error);
    }
  }

  async setPermissions(id: string, codes: readonly string[]): Promise<Role> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      await client.query(
        `INSERT INTO role_permissions (role_id, permission_id)
         SELECT $1, p.id FROM permissions p WHERE p.code = ANY($2::text[])`,
        [id, codes],
      );
      await client.query('UPDATE roles SET updated_at = now() WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return (await this.findById(id))!;
  }
}
