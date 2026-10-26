import type { Pool } from 'pg';
import type { Inventory } from '../../domain/inventory/inventory.js';
import type { InventoryLine } from '../../domain/inventory-line/inventory-line.js';
import type { ScopedRecord } from '../../domain/scope/scope.js';
import type { StockCriteria, StockResult } from '../../domain/stock/stock.js';
import type { StockRepository } from '../../domain/stock/stock-repository.js';
import type { ChangeBatch, ChangeCursor } from '../../domain/sync/change-cursor.js';
import {
  INVENTORY_COLUMNS,
  toInventory,
  type InventoryRow,
} from './postgres-inventory-repository.js';
import { LINE_COLUMNS, toLine, type LineRow } from './postgres-inventory-line-repository.js';
import { escapeLike, VersionedTable } from './versioned-table.js';

interface StockRow {
  line_id: string;
  inventory_id: string;
  inventory_name: string;
  barcode: string;
  expires_on: string | null;
  // numeric is read as text and never converted to Number (ADR-0003)
  quantity_current: string;
  product_id: string;
  sku: string;
  product_name: string;
  unit: string;
  price: string;
}

const FROM = `FROM inventory_lines l
  JOIN inventories i ON i.id = l.inventory_id
  JOIN products p ON p.id = l.product_id
  WHERE i.establishment_id = $1 AND i.is_active AND l.is_active AND p.is_active`;

function toResult(row: StockRow): StockResult {
  return {
    lineId: row.line_id,
    inventoryId: row.inventory_id,
    inventoryName: row.inventory_name,
    barcode: row.barcode,
    expiresOn: row.expires_on,
    quantityCurrent: row.quantity_current,
    product: {
      id: row.product_id,
      sku: row.sku,
      name: row.product_name,
      unit: row.unit,
      price: row.price,
    },
  };
}

/** Stock search and scoped feeds (ADR-0004). Read-only. */
export class PostgresStockRepository implements StockRepository {
  private readonly inventories = new VersionedTable<InventoryRow, Inventory>(
    'inventories',
    INVENTORY_COLUMNS,
    toInventory,
  );
  private readonly lines = new VersionedTable<LineRow, InventoryLine>(
    'inventory_lines',
    LINE_COLUMNS,
    toLine,
  );

  constructor(private readonly pool: Pool) {}

  async search(
    establishmentId: string,
    criteria: StockCriteria,
    limit: number,
    offset: number,
  ): Promise<{ items: StockResult[]; total: number }> {
    const params: unknown[] = [establishmentId];
    let condition: string;
    if ('barcode' in criteria) {
      params.push(criteria.barcode);
      condition = 'l.barcode = $2';
    } else {
      params.push(`%${escapeLike(criteria.q)}%`);
      condition = `(p.name ILIKE $2 ESCAPE '\\' OR p.sku ILIKE $2 ESCAPE '\\')`;
    }
    const total = await this.pool.query<{ count: string }>(
      `SELECT count(*) AS count ${FROM} AND ${condition}`,
      params,
    );
    const { rows } = await this.pool.query<StockRow>(
      `SELECT l.id AS line_id, i.id AS inventory_id, i.name AS inventory_name, l.barcode,
         to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
         l.quantity_current::text AS quantity_current,
         p.id AS product_id, p.sku, p.name AS product_name, p.unit, p.price::text AS price
       ${FROM} AND ${condition}
       ORDER BY lower(p.name) COLLATE "und-x-icu", p.name COLLATE "und-x-icu",
         l.expires_on NULLS LAST, l.id
       LIMIT $3 OFFSET $4`,
      [...params, limit, offset],
    );
    return { items: rows.map(toResult), total: Number(total.rows[0]!.count) };
  }

  listInventoryChanges(
    cursor: ChangeCursor | null,
    limit: number,
    scopeIds: readonly string[],
  ): Promise<ChangeBatch<ScopedRecord<Inventory>>> {
    return this.inventories.listScopedChanges(
      this.pool,
      cursor,
      limit,
      'establishment_id = ANY($4::uuid[])',
      scopeIds,
    );
  }

  listLineChanges(
    cursor: ChangeCursor | null,
    limit: number,
    scopeIds: readonly string[],
  ): Promise<ChangeBatch<ScopedRecord<InventoryLine>>> {
    return this.lines.listScopedChanges(
      this.pool,
      cursor,
      limit,
      `inventory_id IN (SELECT i.id FROM inventories i WHERE i.establishment_id = ANY($4::uuid[]))`,
      scopeIds,
    );
  }
}
