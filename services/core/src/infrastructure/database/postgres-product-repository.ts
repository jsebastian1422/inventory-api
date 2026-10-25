import type { Pool, PoolClient } from 'pg';
import { compareDecimal, PRICE_SCALE } from '../../domain/shared/decimal.js';
import { conflictError, notFoundError } from '../../domain/shared/errors.js';
import type {
  PriceChange,
  Product,
  ProductData,
  ProductUnit,
} from '../../domain/product/product.js';
import type { ProductFilter, ProductRepository } from '../../domain/product/product-repository.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import { FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION, violatedConstraint } from './pool.js';
import {
  addStatusCondition,
  escapeLike,
  inTransaction,
  VersionedTable,
} from './versioned-table.js';

const COLUMNS = `id, sku, name, description, brand, unit, category_id, price::text AS price,
  is_active, version, created_at, updated_at`;

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  brand: string | null;
  unit: ProductUnit;
  category_id: string;
  // numeric is read as text and never converted to Number (ADR-0003)
  price: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    description: row.description,
    brand: row.brand,
    unit: row.unit,
    categoryId: row.category_id,
    price: row.price,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PriceRow {
  id: string;
  old_price: string | null;
  new_price: string;
  actor_id: string;
  changed_at: Date;
}

const CATEGORY_NOT_FOUND = 'Categoría no encontrada';

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    if (violatedConstraint(error) === 'products_pkey') {
      throw conflictError('Ya existe un producto con ese id', 'PRODUCT_ID_TAKEN');
    }
    throw conflictError('Ya existe un producto con ese SKU', 'PRODUCT_SKU_TAKEN');
  }
  if (isPgError(error, FOREIGN_KEY_VIOLATION)) throw notFoundError(CATEGORY_NOT_FOUND);
  throw error;
}

/** Column of each editable field (fixed whitelist: never built from user input). */
const COLUMN_OF: Record<keyof ProductData, string> = {
  sku: 'sku',
  name: 'name',
  description: 'description',
  brand: 'brand',
  unit: 'unit',
  categoryId: 'category_id',
  price: 'price',
};

export class PostgresProductRepository implements ProductRepository {
  private readonly table = new VersionedTable<ProductRow, Product>('products', COLUMNS, toProduct);

  constructor(private readonly pool: Pool) {}

  /** Locks the category FOR SHARE: it must exist and be active (R-8, first lock of the order). */
  private async lockActiveCategory(client: PoolClient, categoryId: string): Promise<void> {
    const { rows } = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM categories WHERE id = $1 FOR SHARE',
      [categoryId],
    );
    if (!rows[0]) throw notFoundError(CATEGORY_NOT_FOUND);
    if (!rows[0].is_active) {
      throw conflictError('La categoría está inactiva', 'CATEGORY_INACTIVE');
    }
  }

  private async insertPrice(
    client: PoolClient,
    productId: string,
    oldPrice: string | null,
    newPrice: string,
    actorId: string,
  ): Promise<void> {
    // changed_at always uses the database clock (now() of the transaction), on create and edit.
    await client.query(
      `INSERT INTO product_price_history (product_id, old_price, new_price, actor_id, changed_at)
       VALUES ($1, $2, $3, $4, now())`,
      [productId, oldPrice, newPrice, actorId],
    );
  }

  async create(data: ProductData, actorId: string, id?: string): Promise<Product> {
    try {
      return await inTransaction(this.pool, async (client) => {
        await this.lockActiveCategory(client, data.categoryId);
        const { rows } = await client.query<ProductRow>(
          `INSERT INTO products (id, sku, name, description, brand, unit, category_id, price)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${COLUMNS}`,
          [
            id ?? null,
            data.sku,
            data.name,
            data.description,
            data.brand,
            data.unit,
            data.categoryId,
            data.price,
          ],
        );
        const product = toProduct(rows[0]!);
        await this.insertPrice(client, product.id, null, product.price, actorId);
        return product;
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  findById(id: string): Promise<Product | null> {
    return this.table.findById(this.pool, id);
  }

  list(filter: ProductFilter): Promise<{ items: Product[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    addStatusCondition(filter.status, conditions, params);
    if (filter.categoryId) {
      params.push(filter.categoryId);
      conditions.push(`category_id = $${params.length}`);
    }
    const q = filter.q?.trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      const n = params.length;
      conditions.push(`(sku ILIKE $${n} ESCAPE '\\' OR name ILIKE $${n} ESCAPE '\\')`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.table.page(
      this.pool,
      where,
      params,
      'lower(name) COLLATE "und-x-icu", id',
      filter.limit,
      filter.offset,
    );
  }

  async update(
    id: string,
    changes: Partial<ProductData>,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Product>> {
    try {
      return await inTransaction(this.pool, async (client) => {
        // Lock order: category (only when it changes) -> product.
        const unlocked = await this.table.findById(client, id);
        if (!unlocked) return { status: 'not_found' } as const;
        if (changes.categoryId !== undefined && changes.categoryId !== unlocked.categoryId) {
          await this.lockActiveCategory(client, changes.categoryId);
        }
        const current = await this.table.findById(client, id, 'FOR UPDATE');
        if (!current) return { status: 'not_found' } as const;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return { status: 'conflict', current } as const;
        }
        const params: unknown[] = [id, now, expectedVersion ?? null];
        const sets = ['updated_at = $2'];
        for (const key of Object.keys(changes) as (keyof ProductData)[]) {
          if (!(key in COLUMN_OF)) continue;
          params.push(changes[key]);
          sets.push(`${COLUMN_OF[key]} = $${params.length}`);
        }
        const outcome = await this.table.conditionalUpdate(client, sets, params);
        if (
          outcome.status === 'updated' &&
          compareDecimal(outcome.value.price, current.price, PRICE_SCALE) !== 0
        ) {
          await this.insertPrice(client, id, current.price, outcome.value.price, actorId);
        }
        return outcome;
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  async setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Product>> {
    const sets = ['updated_at = $2', 'is_active = $4'];
    const params = [id, now, expectedVersion ?? null, isActive];
    return inTransaction(this.pool, async (client) => {
      // Lock order: category (activation) -> product.
      const unlocked = await this.table.findById(client, id);
      if (!unlocked) return { status: 'not_found' } as const;
      if (isActive) await this.lockActiveCategory(client, unlocked.categoryId);
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' } as const;
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current } as const;
      }
      if (!isActive) {
        // Line creation/edition/activation lock the product FOR SHARE, so this check cannot cross them.
        const { rows } = await client.query(
          `SELECT 1 FROM inventory_lines l JOIN inventories i ON i.id = l.inventory_id
           WHERE l.product_id = $1 AND l.is_active AND i.is_active LIMIT 1`,
          [id],
        );
        if (rows.length > 0) {
          throw conflictError(
            'No se puede desactivar un producto presente en líneas activas de inventarios activos',
            'PRODUCT_IN_ACTIVE_INVENTORY',
          );
        }
      }
      return this.table.conditionalUpdate(client, sets, params);
    });
  }

  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Product>> {
    return this.table.listChanges(this.pool, cursor, limit);
  }

  async listPriceHistory(
    productId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PriceChange[]; total: number }> {
    const total = await this.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM product_price_history WHERE product_id = $1',
      [productId],
    );
    const { rows } = await this.pool.query<PriceRow>(
      `SELECT id, old_price::text AS old_price, new_price::text AS new_price, actor_id, changed_at
       FROM product_price_history WHERE product_id = $1
       ORDER BY changed_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [productId, limit, offset],
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        oldPrice: row.old_price,
        newPrice: row.new_price,
        actorId: row.actor_id,
        changedAt: row.changed_at,
      })),
      total: Number(total.rows[0]!.count),
    };
  }
}
