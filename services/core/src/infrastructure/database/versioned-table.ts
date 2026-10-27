import type { Pool, PoolClient } from 'pg';
import type { ScopedRecord } from '../../domain/scope/scope.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import type { StatusFilter } from '../../domain/establishment/establishment-repository.js';

/** Anything that runs queries: the pool or a client inside a transaction. */
export type Db = Pick<Pool, 'query'> | PoolClient;

export type RowLock = 'FOR SHARE' | 'FOR UPDATE';

/** Runs `work` in one transaction (COMMIT on success, ROLLBACK on any error). */
export async function inTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Escapes LIKE wildcards so that `q` is matched as literal text. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/** Adds the `is_active` condition for a status filter (no condition for `all`). */
export function addStatusCondition(
  status: StatusFilter,
  conditions: string[],
  params: unknown[],
  column = 'is_active',
): void {
  if (status === 'all') return;
  params.push(status === 'active');
  conditions.push(`${column} = $${params.length}`);
}

/**
 * Generic SQL for a table with `id`, `version` and `change_xid` (ADR-0002): lookups, the
 * conditional UPDATE by version and the change feed. `columns` is the SELECT list (fixed text).
 */
export class VersionedTable<Row extends { id: string }, T> {
  constructor(
    readonly table: string,
    readonly columns: string,
    readonly map: (row: Row) => T,
  ) {}

  async findById(db: Db, id: string, lock?: RowLock): Promise<T | null> {
    const { rows } = await db.query<Row>(
      `SELECT ${this.columns} FROM ${this.table} WHERE id = $1 ${lock ?? ''}`,
      [id],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  /**
   * $1 id, $2 now, $3 expected version (null = unconditional); extra `sets` use $4 onwards.
   * Increments the version and marks the change position.
   */
  async conditionalUpdate(db: Db, sets: string[], params: unknown[]): Promise<WriteOutcome<T>> {
    const { rows } = await db.query<Row>(
      `UPDATE ${this.table} SET ${sets.join(', ')}, version = version + 1,
         change_xid = pg_current_xact_id()
       WHERE id = $1 AND ($3::integer IS NULL OR version = $3::integer) RETURNING ${this.columns}`,
      params,
    );
    if (rows[0]) return { status: 'updated', value: this.map(rows[0]) };
    const current = await this.findById(db, params[0] as string);
    return current ? { status: 'conflict', current } : { status: 'not_found' };
  }

  /** Page of rows plus the total of the same filter. `where` is a fixed clause with `$n` params. */
  async page(
    db: Db,
    where: string,
    params: unknown[],
    orderBy: string,
    limit: number,
    offset: number,
  ): Promise<{ items: T[]; total: number }> {
    const total = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM ${this.table} ${where}`,
      params,
    );
    const { rows } = await db.query<Row>(
      `SELECT ${this.columns} FROM ${this.table} ${where}
       ORDER BY ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    return { items: rows.map(this.map), total: Number(total.rows[0]!.count) };
  }

  async listChanges(db: Db, cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<T>> {
    // The xmin bound is evaluated in the same statement that reads the rows: a change committed
    // later by an older, still open transaction is never behind the returned cursor.
    const { rows } = await db.query<Row & { change_xid_text: string }>(
      `SELECT ${this.columns}, change_xid::text AS change_xid_text FROM ${this.table}
       WHERE change_xid < pg_snapshot_xmin(pg_current_snapshot())
         AND ($1::xid8 IS NULL OR (change_xid, id) > ($1::xid8, $2::uuid))
       ORDER BY change_xid, id LIMIT $3`,
      [cursor?.xid ?? null, cursor?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(this.map),
      hasMore: rows.length > limit,
      last: last ? { xid: last.change_xid_text, id: last.id } : null,
    };
  }

  /**
   * Feed like `listChanges` limited to the rows where `conditionSql` holds. `conditionSql` is fixed
   * text that may use `$4`, the single parameter `filterValue`.
   */
  async listFilteredChanges(
    db: Db,
    cursor: ChangeCursor | null,
    limit: number,
    conditionSql: string,
    filterValue: unknown,
  ): Promise<ChangeBatch<T>> {
    const { rows } = await db.query<Row & { change_xid_text: string }>(
      `SELECT ${this.columns}, change_xid::text AS change_xid_text FROM ${this.table}
       WHERE change_xid < pg_snapshot_xmin(pg_current_snapshot())
         AND ($1::xid8 IS NULL OR (change_xid, id) > ($1::xid8, $2::uuid))
         AND (${conditionSql})
       ORDER BY change_xid, id LIMIT $3`,
      [cursor?.xid ?? null, cursor?.id ?? null, limit + 1, filterValue],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(this.map),
      hasMore: rows.length > limit,
      last: last ? { xid: last.change_xid_text, id: last.id } : null,
    };
  }

  /**
   * Feed like `listChanges` where each row is complete only when `inScopeSql` holds (ADR-0004);
   * otherwise the page carries just its id. `inScopeSql` is fixed text and may use `$4`, the
   * `uuid[]` of the establishments in scope. `scopeIds` is resolved by the caller in a previous
   * query, so scope and rows are NOT read in the same statement: a change of assignment inside
   * that millisecond window takes effect on the next request (accepted, H-3).
   */
  async listScopedChanges(
    db: Db,
    cursor: ChangeCursor | null,
    limit: number,
    inScopeSql: string,
    scopeIds: readonly string[],
  ): Promise<ChangeBatch<ScopedRecord<T>>> {
    const { rows } = await db.query<Row & { change_xid_text: string; in_scope: boolean }>(
      `SELECT ${this.columns}, change_xid::text AS change_xid_text, (${inScopeSql}) AS in_scope
       FROM ${this.table}
       WHERE change_xid < pg_snapshot_xmin(pg_current_snapshot())
         AND ($1::xid8 IS NULL OR (change_xid, id) > ($1::xid8, $2::uuid))
       ORDER BY change_xid, id LIMIT $3`,
      [cursor?.xid ?? null, cursor?.id ?? null, limit + 1, scopeIds],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row): ScopedRecord<T> =>
        row.in_scope ? { inScope: true, value: this.map(row) } : { inScope: false, id: row.id },
      ),
      hasMore: rows.length > limit,
      last: last ? { xid: last.change_xid_text, id: last.id } : null,
    };
  }
}
