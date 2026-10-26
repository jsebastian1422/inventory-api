import type { Inventory } from '../inventory/inventory.js';
import type { InventoryLine } from '../inventory-line/inventory-line.js';
import type { ScopedRecord } from '../scope/scope.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { StockCriteria, StockResult } from './stock.js';

export interface StockRepository {
  /**
   * Lines of the ACTIVE inventories of the establishment, active lines of active products (R-4,
   * quantity 0 included). Ordered by product name, expiry (nulls last), line id.
   */
  search(
    establishmentId: string,
    criteria: StockCriteria,
    limit: number,
    offset: number,
  ): Promise<{ items: StockResult[]; total: number }>;
  /** Feed of inventories: complete when their establishment is in `scopeIds`, else id only. */
  listInventoryChanges(
    cursor: ChangeCursor | null,
    limit: number,
    scopeIds: readonly string[],
  ): Promise<ChangeBatch<ScopedRecord<Inventory>>>;
  /** Feed of lines: complete when their inventory belongs to an establishment in `scopeIds`. */
  listLineChanges(
    cursor: ChangeCursor | null,
    limit: number,
    scopeIds: readonly string[],
  ): Promise<ChangeBatch<ScopedRecord<InventoryLine>>>;
}
