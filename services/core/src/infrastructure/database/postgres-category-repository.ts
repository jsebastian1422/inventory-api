import type { Pool } from 'pg';
import type { Category, CategoryData } from '../../domain/category/category.js';
import type {
  CategoryFilter,
  CategoryRepository,
} from '../../domain/category/category-repository.js';
import { conflictError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import { isPgError, UNIQUE_VIOLATION, violatedConstraint } from './pool.js';
import {
  addStatusCondition,
  escapeLike,
  inTransaction,
  VersionedTable,
} from './versioned-table.js';

const COLUMNS = 'id, code, name, description, is_active, version, created_at, updated_at';

interface CategoryRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    const constraint = violatedConstraint(error);
    if (constraint === 'categories_pkey') {
      throw conflictError('Ya existe una categoría con ese id', 'CATEGORY_ID_TAKEN');
    }
    if (constraint === 'categories_code_key') {
      throw conflictError('Ya existe una categoría con ese código', 'CATEGORY_CODE_TAKEN');
    }
    throw conflictError('Ya existe una categoría con ese nombre', 'CATEGORY_NAME_TAKEN');
  }
  throw error;
}

/** Column of each editable field (fixed whitelist: never built from user input). */
const COLUMN_OF: Record<keyof CategoryData, string> = {
  code: 'code',
  name: 'name',
  description: 'description',
};

export class PostgresCategoryRepository implements CategoryRepository {
  private readonly table = new VersionedTable<CategoryRow, Category>(
    'categories',
    COLUMNS,
    toCategory,
  );

  constructor(private readonly pool: Pool) {}

  async create(data: CategoryData, id?: string): Promise<Category> {
    try {
      const { rows } = await this.pool.query<CategoryRow>(
        `INSERT INTO categories (id, code, name, description)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4)
         RETURNING ${COLUMNS}`,
        [id ?? null, data.code, data.name, data.description],
      );
      return toCategory(rows[0]!);
    } catch (error) {
      return mapWriteError(error);
    }
  }

  findById(id: string): Promise<Category | null> {
    return this.table.findById(this.pool, id);
  }

  list(filter: CategoryFilter): Promise<{ items: Category[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    addStatusCondition(filter.status, conditions, params);
    const q = filter.q?.trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      const n = params.length;
      conditions.push(`(code ILIKE $${n} ESCAPE '\\' OR name ILIKE $${n} ESCAPE '\\')`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.table.page(this.pool, where, params, 'code, id', filter.limit, filter.offset);
  }

  async update(
    id: string,
    changes: Partial<CategoryData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Category>> {
    const params: unknown[] = [id, now, expectedVersion ?? null];
    const sets = ['updated_at = $2'];
    for (const key of Object.keys(changes) as (keyof CategoryData)[]) {
      if (!(key in COLUMN_OF)) continue;
      params.push(changes[key]);
      sets.push(`${COLUMN_OF[key]} = $${params.length}`);
    }
    try {
      return await this.table.conditionalUpdate(this.pool, sets, params);
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Category>> {
    const sets = ['updated_at = $2', 'is_active = $4'];
    const params = [id, now, expectedVersion ?? null, isActive];
    if (isActive) return this.table.conditionalUpdate(this.pool, sets, params);
    return inTransaction(this.pool, async (client) => {
      // The category row lock serializes with product creation/edition (they lock it FOR SHARE).
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' } as const;
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current } as const;
      }
      const { rows } = await client.query(
        'SELECT 1 FROM products WHERE category_id = $1 AND is_active LIMIT 1',
        [id],
      );
      if (rows.length > 0) {
        throw conflictError(
          'No se puede desactivar una categoría con productos activos',
          'CATEGORY_HAS_ACTIVE_PRODUCTS',
        );
      }
      return this.table.conditionalUpdate(client, sets, params);
    });
  }

  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Category>> {
    return this.table.listChanges(this.pool, cursor, limit);
  }

  async existsByCode(code: string, excludeId?: string): Promise<boolean> {
    return this.exists('code', code, excludeId);
  }

  async existsByName(name: string, excludeId?: string): Promise<boolean> {
    return this.exists('name', name, excludeId);
  }

  private async exists(column: 'code' | 'name', value: string, excludeId?: string) {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM categories WHERE lower(${column}) = lower($1)
       ${excludeId ? 'AND id <> $2' : ''} LIMIT 1`,
      excludeId ? [value, excludeId] : [value],
    );
    return rows.length > 0;
  }
}
