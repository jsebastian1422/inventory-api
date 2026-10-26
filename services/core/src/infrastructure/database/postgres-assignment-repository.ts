import type { Pool, PoolClient } from 'pg';
import type { Assignment, AssignmentUser } from '../../domain/assignment/assignment.js';
import type {
  AssignmentPage,
  AssignmentRepository,
} from '../../domain/assignment/assignment-repository.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import { inTransaction } from './versioned-table.js';

interface AssignmentRow {
  id: string;
  establishment_id: string;
  user_id: string;
  assigned_by: string;
  assigned_at: Date;
  removed_by: string | null;
  removed_at: Date | null;
  full_name: string | null;
  email: string | null;
  user_is_active: boolean | null;
}

/** `users` is identity's table: read-only here (ADR-0001). LEFT JOIN keeps the history if a user is gone. */
const SELECT = `SELECT eu.id, eu.establishment_id, eu.user_id, eu.assigned_by, eu.assigned_at,
    eu.removed_by, eu.removed_at, u.full_name, u.email, u.is_active AS user_is_active
  FROM establishment_users eu LEFT JOIN users u ON u.id = eu.user_id`;

function toAssignment(row: AssignmentRow): Assignment {
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    user: {
      id: row.user_id,
      fullName: row.full_name ?? '',
      email: row.email ?? '',
      isActive: row.user_is_active ?? false,
    },
    assignedBy: row.assigned_by,
    assignedAt: row.assigned_at,
    removedBy: row.removed_by,
    removedAt: row.removed_at,
  };
}

export class PostgresAssignmentRepository implements AssignmentRepository {
  constructor(private readonly pool: Pool) {}

  async findUser(userId: string): Promise<AssignmentUser | null> {
    const { rows } = await this.pool.query<{
      id: string;
      full_name: string;
      email: string;
      is_active: boolean;
    }>('SELECT id, full_name, email, is_active FROM users WHERE id = $1', [userId]);
    const row = rows[0];
    return row
      ? { id: row.id, fullName: row.full_name, email: row.email, isActive: row.is_active }
      : null;
  }

  async assign(
    establishmentId: string,
    userId: string,
    actorId: string,
    now: Date,
  ): Promise<{ assignment: Assignment; created: boolean }> {
    return inTransaction(this.pool, async (client) => {
      // FOR SHARE: a concurrent deactivation of the establishment waits for this transaction.
      const establishment = await client.query<{ is_active: boolean }>(
        'SELECT is_active FROM establishments WHERE id = $1 FOR SHARE',
        [establishmentId],
      );
      if (!establishment.rows[0]) throw notFoundError('Establecimiento no encontrado');
      if (!establishment.rows[0].is_active) {
        throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO establishment_users (establishment_id, user_id, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (establishment_id, user_id) WHERE removed_at IS NULL DO NOTHING
         RETURNING id`,
        [establishmentId, userId, actorId, now],
      );
      if (inserted.rows[0]) {
        return { assignment: await this.byId(client, inserted.rows[0].id), created: true };
      }
      // The pair is already assigned (possibly committed by a concurrent request): answer it.
      const existing = await client.query<AssignmentRow>(
        `${SELECT} WHERE eu.establishment_id = $1 AND eu.user_id = $2 AND eu.removed_at IS NULL`,
        [establishmentId, userId],
      );
      if (existing.rows[0]) return { assignment: toAssignment(existing.rows[0]), created: false };
      // Removed between the conflict and the read: assign again (the next INSERT cannot conflict twice in practice).
      const retry = await client.query<{ id: string }>(
        `INSERT INTO establishment_users (establishment_id, user_id, assigned_by, assigned_at)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [establishmentId, userId, actorId, now],
      );
      return { assignment: await this.byId(client, retry.rows[0]!.id), created: true };
    });
  }

  private async byId(client: PoolClient, id: string): Promise<Assignment> {
    const { rows } = await client.query<AssignmentRow>(`${SELECT} WHERE eu.id = $1`, [id]);
    return toAssignment(rows[0]!);
  }

  async remove(
    establishmentId: string,
    userId: string,
    actorId: string,
    now: Date,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE establishment_users SET removed_at = $4, removed_by = $3
       WHERE establishment_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [establishmentId, userId, actorId, now],
    );
    return (rowCount ?? 0) > 0;
  }

  listByEstablishment(establishmentId: string, page: AssignmentPage) {
    return this.page('eu.establishment_id = $1', establishmentId, page);
  }

  listByUser(userId: string, page: AssignmentPage) {
    return this.page('eu.user_id = $1', userId, page);
  }

  private async page(
    condition: string,
    param: string,
    page: AssignmentPage,
  ): Promise<{ items: Assignment[]; total: number }> {
    const where = `WHERE ${condition}${page.includeRemoved ? '' : ' AND eu.removed_at IS NULL'}`;
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM establishment_users eu ${where}`,
      [param],
    );
    const { rows } = await this.pool.query<AssignmentRow>(
      `${SELECT} ${where} ORDER BY eu.assigned_at DESC, eu.id LIMIT $2 OFFSET $3`,
      [param, page.limit, page.offset],
    );
    return { items: rows.map(toAssignment), total: Number(total.rows[0]!.count) };
  }
}
