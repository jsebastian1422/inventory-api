import type { Pool } from 'pg';
import type { Establishment, EstablishmentData } from '../../domain/establishment/establishment.js';
import type {
  EstablishmentFilter,
  EstablishmentRepository,
} from '../../domain/establishment/establishment-repository.js';
import { conflictError } from '../../domain/shared/errors.js';
import { isPgError, UNIQUE_VIOLATION } from './pool.js';

const COLUMNS = `id, name, address, city, department, phone, latitude, longitude, is_active,
  created_at, updated_at`;

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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
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

  async create(data: EstablishmentData): Promise<Establishment> {
    try {
      const { rows } = await this.pool.query<EstablishmentRow>(
        `INSERT INTO establishments (name, address, city, department, phone, latitude, longitude)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
        [
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
  ): Promise<Establishment | null> {
    const keys = (Object.keys(changes) as (keyof EstablishmentData)[]).filter(
      (key) => key in COLUMN_OF,
    );
    const params: unknown[] = [id, now];
    const sets = ['updated_at = $2'];
    for (const key of keys) {
      params.push(changes[key]);
      sets.push(`${COLUMN_OF[key]} = $${params.length}`);
    }
    try {
      const { rows } = await this.pool.query<EstablishmentRow>(
        `UPDATE establishments SET ${sets.join(', ')} WHERE id = $1 RETURNING ${COLUMNS}`,
        params,
      );
      return rows[0] ? toEstablishment(rows[0]) : null;
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async setActive(id: string, isActive: boolean, now: Date): Promise<Establishment | null> {
    const { rows } = await this.pool.query<EstablishmentRow>(
      `UPDATE establishments SET is_active = $2, updated_at = $3 WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, isActive, now],
    );
    return rows[0] ? toEstablishment(rows[0]) : null;
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
