import type { Pool, PoolClient } from 'pg';
import type { Inventory, InventoryData } from '../../domain/inventory/inventory.js';
import { DATES_ORDER_MESSAGE } from '../../domain/inventory/inventory.js';
import type {
  InventoryFilter,
  InventoryRepository,
} from '../../domain/inventory/inventory-repository.js';
import { conflictError, notFoundError, validationError } from '../../domain/shared/errors.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import { CHECK_VIOLATION, FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION } from './pool.js';
import {
  addStatusCondition,
  escapeLike,
  inTransaction,
  VersionedTable,
} from './versioned-table.js';

const COLUMNS = `id, establishment_id, name, to_char(start_date, 'YYYY-MM-DD') AS start_date,
  to_char(end_date, 'YYYY-MM-DD') AS end_date, origin, notes, is_active, version, created_at,
  updated_at`;

interface InventoryRow {
  id: string;
  establishment_id: string;
  name: string;
  start_date: string;
  end_date: string;
  origin: string;
  notes: string | null;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toInventory(row: InventoryRow): Inventory {
  return {
    id: row.id,
    establishmentId: row.establishment_id,
    name: row.name,
    startDate: row.start_date,
    endDate: row.end_date,
    origin: row.origin,
    notes: row.notes,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ESTABLISHMENT_NOT_FOUND = 'Establecimiento no encontrado';

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    throw conflictError('Ya existe un inventario con ese id', 'INVENTORY_ID_TAKEN');
  }
  if (isPgError(error, FOREIGN_KEY_VIOLATION)) throw notFoundError(ESTABLISHMENT_NOT_FOUND);
  if (isPgError(error, CHECK_VIOLATION)) {
    // Concurrent edits of one date each valid on their own can still break end >= start.
    throw validationError('Datos inválidos', [{ field: 'endDate', message: DATES_ORDER_MESSAGE }]);
  }
  throw error;
}

/** Column of each editable field (fixed whitelist: never built from user input). */
const COLUMN_OF: Record<keyof InventoryData, string> = {
  establishmentId: 'establishment_id',
  name: 'name',
  startDate: 'start_date',
  endDate: 'end_date',
  origin: 'origin',
  notes: 'notes',
};

export class PostgresInventoryRepository implements InventoryRepository {
  private readonly table = new VersionedTable<InventoryRow, Inventory>(
    'inventories',
    COLUMNS,
    toInventory,
  );

  constructor(private readonly pool: Pool) {}

  /** Locks the establishment FOR SHARE: it must exist (404); answers whether it is active. */
  private async lockEstablishment(client: PoolClient, id: string): Promise<boolean> {
    const { rows } = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM establishments WHERE id = $1 FOR SHARE',
      [id],
    );
    if (!rows[0]) throw notFoundError(ESTABLISHMENT_NOT_FOUND);
    return rows[0].is_active;
  }

  /** Locks the establishment FOR SHARE: it must exist and be active. */
  private async lockActiveEstablishment(client: PoolClient, id: string): Promise<void> {
    if (!(await this.lockEstablishment(client, id))) {
      throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
    }
  }

  async create(data: InventoryData, id?: string): Promise<Inventory> {
    try {
      return await inTransaction(this.pool, async (client) => {
        await this.lockActiveEstablishment(client, data.establishmentId);
        const { rows } = await client.query<InventoryRow>(
          `INSERT INTO inventories (id, establishment_id, name, start_date, end_date, origin, notes)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7)
           RETURNING ${COLUMNS}`,
          [
            id ?? null,
            data.establishmentId,
            data.name,
            data.startDate,
            data.endDate,
            data.origin,
            data.notes,
          ],
        );
        return toInventory(rows[0]!);
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  findById(id: string): Promise<Inventory | null> {
    return this.table.findById(this.pool, id);
  }

  list(filter: InventoryFilter): Promise<{ items: Inventory[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    addStatusCondition(filter.status, conditions, params);
    if (filter.establishmentId) {
      params.push(filter.establishmentId);
      conditions.push(`establishment_id = $${params.length}`);
    }
    const q = filter.q?.trim();
    if (q) {
      params.push(`%${escapeLike(q)}%`);
      conditions.push(`name ILIKE $${params.length} ESCAPE '\\'`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    return this.table.page(
      this.pool,
      where,
      params,
      'start_date DESC, lower(name) COLLATE "und-x-icu", id',
      filter.limit,
      filter.offset,
    );
  }

  async update(
    id: string,
    changes: Partial<InventoryData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Inventory>> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const unlocked = await this.table.findById(client, id);
        if (!unlocked) return { status: 'not_found' } as const;
        // Lock order: establishment (only when it changes) -> inventory.
        if (
          changes.establishmentId !== undefined &&
          changes.establishmentId !== unlocked.establishmentId
        ) {
          await this.lockActiveEstablishment(client, changes.establishmentId);
        }
        const params: unknown[] = [id, now, expectedVersion ?? null];
        const sets = ['updated_at = $2'];
        for (const key of Object.keys(changes) as (keyof InventoryData)[]) {
          if (!(key in COLUMN_OF)) continue;
          params.push(changes[key]);
          sets.push(`${COLUMN_OF[key]} = $${params.length}`);
        }
        return this.table.conditionalUpdate(client, sets, params);
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  /**
   * Deactivation: the UPDATE takes the row lock, so line operations holding it FOR SHARE finish first.
   * Activation (R-8, lock order establishment -> product -> inventory): the establishment is locked
   * FOR SHARE, then the products of the active lines FOR SHARE (by id), then the inventory row.
   * Once locked and the version checked, the establishment must be active (409
   * ESTABLISHMENT_INACTIVE) and, after that, no active line may have an inactive product (409
   * INVENTORY_HAS_INACTIVE_PRODUCTS). A product or establishment deactivation (FOR UPDATE / row
   * lock) therefore either finishes first (the activation sees it) or waits until the inventory is
   * active (and then sees the active line).
   */
  async setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Inventory>> {
    const sets = ['updated_at = $2', 'is_active = $4'];
    const params = [id, now, expectedVersion ?? null, isActive];
    if (!isActive) return this.table.conditionalUpdate(this.pool, sets, params);
    return inTransaction(this.pool, async (client) => {
      const unlocked = await this.table.findById(client, id);
      if (!unlocked) return { status: 'not_found' } as const;
      const establishmentActive = await this.lockEstablishment(client, unlocked.establishmentId);
      await client.query(
        `SELECT id FROM products WHERE id IN (
           SELECT product_id FROM inventory_lines WHERE inventory_id = $1 AND is_active)
         ORDER BY id FOR SHARE`,
        [id],
      );
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' } as const;
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current } as const;
      }
      if (!establishmentActive) {
        throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
      }
      const { rows } = await client.query<{ line_id: string; product_id: string }>(
        `SELECT l.id AS line_id, l.product_id FROM inventory_lines l
         JOIN products p ON p.id = l.product_id
         WHERE l.inventory_id = $1 AND l.is_active AND NOT p.is_active ORDER BY l.id`,
        [id],
      );
      if (rows.length > 0) {
        throw conflictError(
          'El inventario tiene líneas activas con productos inactivos; reactiva esos productos o desactiva esas líneas',
          'INVENTORY_HAS_INACTIVE_PRODUCTS',
          undefined,
          rows.map((row) => ({ lineId: row.line_id, productId: row.product_id })),
        );
      }
      return this.table.conditionalUpdate(client, sets, params);
    });
  }

  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Inventory>> {
    return this.table.listChanges(this.pool, cursor, limit);
  }
}
