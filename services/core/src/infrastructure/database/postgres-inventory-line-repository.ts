import type { Pool, PoolClient } from 'pg';
import {
  addDecimal,
  isNegativeDecimal,
  MAX_QUANTITY_UNITS,
  QUANTITY_SCALE,
  subtractDecimal,
  toUnits,
} from '../../domain/shared/decimal.js';
import { conflictError, notFoundError, validationError } from '../../domain/shared/errors.js';
import {
  initialChanged,
  type InventoryLine,
  type InventoryLineData,
  type LineHistoryEntry,
  type LineHistoryReason,
  type NewInventoryLine,
} from '../../domain/inventory-line/inventory-line.js';
import type {
  InventoryLineFilter,
  InventoryLineRepository,
} from '../../domain/inventory-line/inventory-line-repository.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import type { WriteOutcome } from '../../domain/sync/version.js';
import { FOREIGN_KEY_VIOLATION, isPgError, UNIQUE_VIOLATION, violatedConstraint } from './pool.js';
import { addStatusCondition, inTransaction, VersionedTable } from './versioned-table.js';

const COLUMNS = `id, inventory_id, product_id, barcode, to_char(expires_on, 'YYYY-MM-DD') AS expires_on,
  quantity_initial::text AS quantity_initial, quantity_alert::text AS quantity_alert,
  quantity_current::text AS quantity_current, is_active, version, created_at, updated_at`;

interface LineRow {
  id: string;
  inventory_id: string;
  product_id: string;
  barcode: string;
  expires_on: string | null;
  // numeric is read as text and never converted to Number (ADR-0003)
  quantity_initial: string;
  quantity_alert: string;
  quantity_current: string;
  is_active: boolean;
  version: number;
  created_at: Date;
  updated_at: Date;
}

function toLine(row: LineRow): InventoryLine {
  return {
    id: row.id,
    inventoryId: row.inventory_id,
    productId: row.product_id,
    barcode: row.barcode,
    expiresOn: row.expires_on,
    quantityInitial: row.quantity_initial,
    quantityAlert: row.quantity_alert,
    quantityCurrent: row.quantity_current,
    isActive: row.is_active,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface HistoryRow {
  id: string;
  reason: LineHistoryReason;
  initial_before: string | null;
  initial_after: string;
  current_before: string | null;
  current_after: string;
  delta: string | null;
  actor_id: string;
  changed_at: Date;
}

function mapWriteError(error: unknown): never {
  if (isPgError(error, UNIQUE_VIOLATION)) {
    if (violatedConstraint(error) === 'inventory_lines_pkey') {
      throw conflictError('Ya existe una línea con ese id', 'INVENTORY_LINE_ID_TAKEN');
    }
    throw conflictError(
      'Ya existe una línea con ese código de barras y vencimiento en el inventario',
      'INVENTORY_LINE_DUPLICATE',
    );
  }
  if (isPgError(error, FOREIGN_KEY_VIOLATION)) throw notFoundError('Referencia no encontrada');
  throw error;
}

/** Column of each editable field (fixed whitelist: never built from user input). */
const COLUMN_OF: Record<keyof InventoryLineData, string> = {
  barcode: 'barcode',
  expiresOn: 'expires_on',
  quantityInitial: 'quantity_initial',
  quantityAlert: 'quantity_alert',
};

const INVENTORY_NOT_FOUND = 'Inventario no encontrado';
const PRODUCT_NOT_FOUND = 'Producto no encontrado';

interface Parents {
  readonly productActive: boolean | null;
  readonly inventoryActive: boolean | null;
}

export class PostgresInventoryLineRepository implements InventoryLineRepository {
  private readonly table = new VersionedTable<LineRow, InventoryLine>(
    'inventory_lines',
    COLUMNS,
    toLine,
  );

  constructor(private readonly pool: Pool) {}

  /**
   * Locks the product and then the inventory FOR SHARE (R-8 order: product -> inventory), so that
   * their deactivation (which takes the row lock) cannot cross a line write. Null = not found.
   */
  private async lockParents(
    client: PoolClient,
    productId: string,
    inventoryId: string,
  ): Promise<Parents> {
    const product = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM products WHERE id = $1 FOR SHARE',
      [productId],
    );
    const inventory = await client.query<{ is_active: boolean }>(
      'SELECT is_active FROM inventories WHERE id = $1 FOR SHARE',
      [inventoryId],
    );
    return {
      productActive: product.rows[0]?.is_active ?? null,
      inventoryActive: inventory.rows[0]?.is_active ?? null,
    };
  }

  /** Throws 404 for a missing parent and 409 for an inactive one (inventory first). */
  private assertParentsUsable(parents: Parents): void {
    if (parents.inventoryActive === null) throw notFoundError(INVENTORY_NOT_FOUND);
    if (parents.productActive === null) throw notFoundError(PRODUCT_NOT_FOUND);
    if (!parents.inventoryActive) {
      throw conflictError('El inventario está inactivo', 'INVENTORY_INACTIVE');
    }
    if (!parents.productActive)
      throw conflictError('El producto está inactivo', 'PRODUCT_INACTIVE');
  }

  private async insertHistory(
    client: PoolClient,
    entry: {
      lineId: string;
      reason: LineHistoryReason;
      initialBefore: string | null;
      initialAfter: string;
      currentBefore: string | null;
      currentAfter: string;
      delta: string | null;
      actorId: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO inventory_line_history (line_id, reason, initial_before, initial_after,
         current_before, current_after, delta, actor_id, changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
      [
        entry.lineId,
        entry.reason,
        entry.initialBefore,
        entry.initialAfter,
        entry.currentBefore,
        entry.currentAfter,
        entry.delta,
        entry.actorId,
      ],
    );
  }

  async create(
    inventoryId: string,
    data: NewInventoryLine,
    actorId: string,
    id?: string,
  ): Promise<InventoryLine> {
    try {
      return await inTransaction(this.pool, async (client) => {
        this.assertParentsUsable(await this.lockParents(client, data.productId, inventoryId));
        const { rows } = await client.query<LineRow>(
          `INSERT INTO inventory_lines (id, inventory_id, product_id, barcode, expires_on,
             quantity_initial, quantity_alert, quantity_current)
           VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $6)
           RETURNING ${COLUMNS}`,
          [
            id ?? null,
            inventoryId,
            data.productId,
            data.barcode,
            data.expiresOn,
            data.quantityInitial,
            data.quantityAlert,
          ],
        );
        const line = toLine(rows[0]!);
        await this.insertHistory(client, {
          lineId: line.id,
          reason: 'created',
          initialBefore: null,
          initialAfter: line.quantityInitial,
          currentBefore: null,
          currentAfter: line.quantityCurrent,
          delta: null,
          actorId,
        });
        return line;
      });
    } catch (error) {
      return mapWriteError(error);
    }
  }

  findById(id: string): Promise<InventoryLine | null> {
    return this.table.findById(this.pool, id);
  }

  listByInventory(
    inventoryId: string,
    filter: InventoryLineFilter,
  ): Promise<{ items: InventoryLine[]; total: number }> {
    const conditions = ['inventory_id = $1'];
    const params: unknown[] = [inventoryId];
    addStatusCondition(filter.status, conditions, params);
    if (filter.productId) {
      params.push(filter.productId);
      conditions.push(`product_id = $${params.length}`);
    }
    if (filter.barcode) {
      params.push(filter.barcode);
      conditions.push(`barcode = $${params.length}`);
    }
    return this.table.page(
      this.pool,
      `WHERE ${conditions.join(' AND ')}`,
      params,
      'barcode, expires_on NULLS FIRST, id',
      filter.limit,
      filter.offset,
    );
  }

  async update(
    id: string,
    changes: Partial<InventoryLineData>,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<InventoryLine>> {
    try {
      return await inTransaction(this.pool, async (client) => {
        const unlocked = await this.table.findById(client, id);
        if (!unlocked) return { status: 'not_found' } as const;
        const parents = await this.lockParents(client, unlocked.productId, unlocked.inventoryId);
        const current = await this.table.findById(client, id, 'FOR UPDATE');
        if (!current) return { status: 'not_found' } as const;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          return { status: 'conflict', current } as const;
        }
        this.assertParentsUsable(parents);

        const params: unknown[] = [id, now, expectedVersion ?? null];
        const sets = ['updated_at = $2'];
        for (const key of Object.keys(changes) as (keyof InventoryLineData)[]) {
          if (!(key in COLUMN_OF)) continue;
          params.push(changes[key]);
          sets.push(`${COLUMN_OF[key]} = $${params.length}`);
        }
        let adjustment: { newCurrent: string; delta: string } | null = null;
        if (initialChanged(current, changes)) {
          const delta = subtractDecimal(
            changes.quantityInitial!,
            current.quantityInitial,
            QUANTITY_SCALE,
          );
          const newCurrent = addDecimal(current.quantityCurrent, delta, QUANTITY_SCALE);
          if (isNegativeDecimal(newCurrent, QUANTITY_SCALE)) {
            throw conflictError(
              'La cantidad actual quedaría negativa con esa cantidad inicial',
              'QUANTITY_BELOW_ZERO',
            );
          }
          if (toUnits(newCurrent, QUANTITY_SCALE) > MAX_QUANTITY_UNITS) {
            throw validationError('Datos inválidos', [
              {
                field: 'quantityInitial',
                message: 'La cantidad actual resultante excede el máximo',
              },
            ]);
          }
          params.push(newCurrent);
          sets.push(`quantity_current = $${params.length}`);
          adjustment = { newCurrent, delta };
        }
        const outcome = await this.table.conditionalUpdate(client, sets, params);
        if (outcome.status === 'updated' && adjustment) {
          await this.insertHistory(client, {
            lineId: id,
            reason: 'initial_adjusted',
            initialBefore: current.quantityInitial,
            initialAfter: outcome.value.quantityInitial,
            currentBefore: current.quantityCurrent,
            currentAfter: adjustment.newCurrent,
            delta: adjustment.delta,
            actorId,
          });
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
  ): Promise<WriteOutcome<InventoryLine>> {
    const sets = ['updated_at = $2', 'is_active = $4'];
    const params = [id, now, expectedVersion ?? null, isActive];
    // Deactivating is always allowed, also in an inactive inventory.
    if (!isActive) return this.table.conditionalUpdate(this.pool, sets, params);
    return inTransaction(this.pool, async (client) => {
      const unlocked = await this.table.findById(client, id);
      if (!unlocked) return { status: 'not_found' } as const;
      const parents = await this.lockParents(client, unlocked.productId, unlocked.inventoryId);
      const current = await this.table.findById(client, id, 'FOR UPDATE');
      if (!current) return { status: 'not_found' } as const;
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        return { status: 'conflict', current } as const;
      }
      this.assertParentsUsable(parents);
      return this.table.conditionalUpdate(client, sets, params);
    });
  }

  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<InventoryLine>> {
    return this.table.listChanges(this.pool, cursor, limit);
  }

  async listHistory(
    lineId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: LineHistoryEntry[]; total: number }> {
    const total = await this.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM inventory_line_history WHERE line_id = $1',
      [lineId],
    );
    const { rows } = await this.pool.query<HistoryRow>(
      `SELECT id, reason, initial_before::text AS initial_before, initial_after::text AS initial_after,
         current_before::text AS current_before, current_after::text AS current_after,
         delta::text AS delta, actor_id, changed_at
       FROM inventory_line_history WHERE line_id = $1
       ORDER BY changed_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [lineId, limit, offset],
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        initialBefore: row.initial_before,
        initialAfter: row.initial_after,
        currentBefore: row.current_before,
        currentAfter: row.current_after,
        delta: row.delta,
        actorId: row.actor_id,
        changedAt: row.changed_at,
      })),
      total: Number(total.rows[0]!.count),
    };
  }
}

export { COLUMNS as LINE_COLUMNS, toLine };
export type { LineRow };
