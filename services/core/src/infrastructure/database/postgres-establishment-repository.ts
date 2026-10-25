import type { Pool } from 'pg';
import type { Establishment, EstablishmentData } from '../../domain/establishment/establishment.js';
import type {
  EstablishmentFilter,
  EstablishmentRepository,
} from '../../domain/establishment/establishment-repository.js';
import { conflictError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import { isPgError, UNIQUE_VIOLATION } from './pool.js';

const COLUMNS = `id, name, address, city, department, phone, latitude, longitude, is_active,
  version, created_at, updated_at`;

interface EstablishmentRow {
  id: string;
  name: string;
  address: string;
  city: string;
  department: string;
  phone: string | null;
  // numeric arrives as text from pg
  latitude: string;
  longitude: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toEstablishment(row: EstablishmentRow): Establishment {
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    city: row.city,
    department: row.department,
    phone: row.phone,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const PRIMARY_KEY = 'establishments_pkey';

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    if ((error as { constraint?: string }).constraint === PRIMARY_KEY) {
      throw conflictError('Ya existe un establecimiento con ese id', 'ESTABLISHMENT_ID_TAKEN');
    }
    throw conflictError('Ya existe un establecimiento con ese nombre', 'ESTABLISHMENT_NAME_TAKEN');
  }
  throw error;
}

/** Column of each editable field (fixed whitelist: never built from user input). */
const COLUMN_OF: Record<keyof EstablishmentData, string> = {
  name: 'name',
  address: 'address',
  city: 'city',
  department: 'department',
  phone: 'phone',
  latitude: 'latitude',
  longitude: 'longitude',
};

/** Escapes LIKE wildcards so that `q` is matched as literal text. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export class PostgresEstablishmentRepository implements EstablishmentRepository {
  constructor(private readonly pool: Pool) {}

  async create(data: EstablishmentData, id?: string): Promise<Establishment> {
    try {
      const { rows } = await this.pool.query<EstablishmentRow>(
        `INSERT INTO establishments (id, name, address, city, department, phone, latitude, longitude)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${COLUMNS}`,
        [
          id ?? null,
          data.name,
          data.address,
          data.city,
          data.department,
          data.phone,
          data.latitude,
          data.longitude,
        ],
      );
      return toEstablishment(rows[0]!);
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async findById(id: string): Promise<Establishment | null> {
    const { rows } = await this.pool.query<EstablishmentRow>(
      `SELECT ${COLUMNS} FROM establishments WHERE id = $1`,
      [id],
    );
    return rows[0] ? toEstablishment(rows[0]) : null;
  }

  async list(filter: EstablishmentFilter): Promise<{ items: Establishment[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.status !== 'all') {
      params.push(filter.status === 'active');
      conditions.push(`is_active = $${params.length}`);
    }
    const q = filter.q?.trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      const n = params.length;
      conditions.push(`(name ILIKE $${n} ESCAPE '\\' OR city ILIKE $${n} ESCAPE '\\')`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM establishments ${where}`,
      params,
    );
    const { rows } = await this.pool.query<EstablishmentRow>(
      `SELECT ${COLUMNS} FROM establishments ${where}
       ORDER BY lower(name) COLLATE "und-x-icu", id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
    );
    return { items: rows.map(toEstablishment), total: Number(total.rows[0]!.count) };
  }

  async update(
    id: string,
    changes: Partial<EstablishmentData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>> {
    const keys = (Object.keys(changes) as (keyof EstablishmentData)[]).filter(
      (key) => key in COLUMN_OF,
    );
    const params: unknown[] = [id, now, expectedVersion ?? null];
    const sets = ['updated_at = $2'];
    for (const key of keys) {
      params.push(changes[key]);
      sets.push(`${COLUMN_OF[key]} = $${params.length}`);
    }
    try {
      return await this.conditionalUpdate(sets, params);
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>> {
    return this.conditionalUpdate(
      ['updated_at = $2', 'is_active = $4'],
      [id, now, expectedVersion ?? null, isActive],
    );
  }

  /** $1 id, $2 now, $3 expected version (null = unconditional); extra `sets` use $4 onwards. */
  private async conditionalUpdate(
    sets: string[],
    params: unknown[],
  ): Promise<WriteOutcome<Establishment>> {
    const { rows } = await this.pool.query<EstablishmentRow>(
      `UPDATE establishments SET ${sets.join(', ')}, version = version + 1,
         change_xid = pg_current_xact_id()
       WHERE id = $1 AND ($3::integer IS NULL OR version = $3::integer) RETURNING ${COLUMNS}`,
      params,
    );
    if (rows[0]) return { status: 'updated', value: toEstablishment(rows[0]) };
    const current = await this.findById(params[0] as string);
    return current ? { status: 'conflict', current } : { status: 'not_found' };
  }

  async listChanges(
    cursor: ChangeCursor | null,
    limit: number,
  ): Promise<ChangeBatch<Establishment>> {
    // The xmin bound is evaluated in the same statement that reads the rows: a change committed
    // later by an older, still open transaction is never behind the returned cursor.
    const { rows } = await this.pool.query<EstablishmentRow & { change_xid_text: string }>(
      `SELECT ${COLUMNS}, change_xid::text AS change_xid_text FROM establishments
       WHERE change_xid < pg_snapshot_xmin(pg_current_snapshot())
         AND ($1::xid8 IS NULL OR (change_xid, id) > ($1::xid8, $2::uuid))
       ORDER BY change_xid, id LIMIT $3`,
      [cursor?.xid ?? null, cursor?.id ?? null, limit + 1],
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toEstablishment),
      hasMore: rows.length > limit,
      last: last ? { xid: last.change_xid_text, id: last.id } : null,
    };
  }

  async existsByName(name: string, excludeId?: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM establishments WHERE lower(name) = lower($1)
       ${excludeId ? 'AND id <> $2' : ''} LIMIT 1`,
      excludeId ? [name, excludeId] : [name],
    );
    return rows.length > 0;
  }
}
