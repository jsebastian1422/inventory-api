import type { Pool } from 'pg';
import type { EstablishmentScope } from '../../domain/scope/scope.js';
import type { ScopeReader } from '../../domain/scope/scope-reader.js';

const ALL_ACTIVE = 'SELECT id FROM establishments WHERE is_active';
const ASSIGNED_ACTIVE = `SELECT e.id FROM establishments e
  JOIN establishment_users eu ON eu.establishment_id = e.id
  WHERE eu.user_id = $1 AND eu.removed_at IS NULL AND e.is_active`;

/** Live scope (ADR-0004): one query per request, no cache. Read-only. */
export class PostgresScopeReader implements ScopeReader {
  constructor(private readonly pool: Pool) {}

  async resolve(userId: string, all: boolean): Promise<EstablishmentScope> {
    const { rows } = all
      ? await this.pool.query<{ id: string }>(ALL_ACTIVE)
      : await this.pool.query<{ id: string }>(ASSIGNED_ACTIVE, [userId]);
    return { access: all ? 'all' : 'assigned', ids: rows.map((row) => row.id) };
  }
}
