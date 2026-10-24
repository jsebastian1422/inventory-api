import type { Pool, PoolClient } from 'pg';
import type { RoleSummary, User, UserWithPasswordHash } from '../../domain/user/user.js';
import type { NewUser, UserChanges, UserRepository } from '../../domain/user/user-repository.js';
import { conflictError, validationError } from '../../domain/shared/errors.js';
import { FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION } from './pool.js';

const SELECT_USER = `
  SELECT u.id, u.email, u.full_name, u.is_active, u.last_login_at, u.created_at, u.updated_at,
         u.password_hash, r.id AS role_id, r.name AS role_name, r.is_system AS role_is_system
  FROM users u JOIN roles r ON r.id = u.role_id`;

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
  password_hash: string;
  role_id: string;
  role_name: string;
  role_is_system: boolean;
}

function toUser(row: UserRow): User {
  const role: RoleSummary = { id: row.role_id, name: row.role_name, isSystem: row.role_is_system };
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role,
    isActive: row.is_active,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    throw conflictError('Ya existe un usuario con ese correo electrónico', 'EMAIL_ALREADY_USED');
  }
  if (isPgError(error, FOREIGN_KEY_VIOLATION)) {
    throw validationError('Datos inválidos', [
      { field: 'roleId', message: 'El rol indicado no existe' },
    ]);
  }
  throw error;
}

/** Arbitrary 64-bit key of the advisory lock that serializes administrator-affecting writes. */
const ADMIN_CHANGES_LOCK_KEY = 7301002;

export class PostgresUserRepository implements UserRepository {
  /** `pool` is a Pool, or a PoolClient when the repository is bound to a transaction. */
  constructor(private readonly pool: Pick<Pool, 'query'>) {}

  async runExclusive<T>(work: (users: UserRepository) => Promise<T>): Promise<T> {
    const client: PoolClient = await (this.pool as Pool).connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [ADMIN_CHANGES_LOCK_KEY]);
      const result = await work(new PostgresUserRepository(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async list(limit: number, offset: number): Promise<{ items: User[]; total: number }> {
    const [rows, count] = await Promise.all([
      this.pool.query<UserRow>(`${SELECT_USER} ORDER BY u.created_at, u.id LIMIT $1 OFFSET $2`, [
        limit,
        offset,
      ]),
      this.pool.query<{ total: string }>('SELECT count(*) AS total FROM users'),
    ]);
    return { items: rows.rows.map(toUser), total: Number(count.rows[0]?.total ?? 0) };
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await this.pool.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findWithPasswordHashById(id: string): Promise<UserWithPasswordHash | null> {
    const { rows } = await this.pool.query<UserRow>(`${SELECT_USER} WHERE u.id = $1`, [id]);
    return rows[0] ? { user: toUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async findWithPasswordHashByEmail(email: string): Promise<UserWithPasswordHash | null> {
    const { rows } = await this.pool.query<UserRow>(
      `${SELECT_USER} WHERE lower(u.email) = lower($1)`,
      [email],
    );
    return rows[0] ? { user: toUser(rows[0]), passwordHash: rows[0].password_hash } : null;
  }

  async create(data: NewUser): Promise<User> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, full_name, role_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [data.email, data.passwordHash, data.fullName, data.roleId],
      );
      return (await this.findById(rows[0]!.id))!;
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async update(id: string, changes: UserChanges): Promise<User> {
    const columns: Array<[string, string | undefined]> = [
      ['email', changes.email],
      ['full_name', changes.fullName],
      ['role_id', changes.roleId],
    ];
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [column, value] of columns) {
      if (value !== undefined) {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    values.push(id);
    try {
      await this.pool.query(
        `UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length}`,
        values,
      );
    } catch (error) {
      return mapWriteError(error);
    }
    return (await this.findById(id))!;
  }

  async setActive(id: string, isActive: boolean): Promise<void> {
    await this.pool.query('UPDATE users SET is_active = $2, updated_at = now() WHERE id = $1', [
      id,
      isActive,
    ]);
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1', [
      id,
      passwordHash,
    ]);
  }

  async touchLastLogin(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [id, at]);
  }

  async countActiveSystemRoleUsers(excludeUserId?: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.is_system AND u.is_active AND ($1::uuid IS NULL OR u.id <> $1::uuid)`,
      [excludeUserId ?? null],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async countByRole(roleId: string): Promise<number> {
    const { rows } = await this.pool.query<{ total: string }>(
      'SELECT count(*) AS total FROM users WHERE role_id = $1',
      [roleId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
