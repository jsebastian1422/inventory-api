import type { StatusFilter } from '../establishment/establishment-repository.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { WriteOutcome } from '../sync/version.js';
import type {
  InventoryLine,
  InventoryLineData,
  LineHistoryEntry,
  NewInventoryLine,
} from './inventory-line.js';

export interface InventoryLineFilter {
  readonly status: StatusFilter;
  readonly productId?: string;
  /** Exact barcode. */
  readonly barcode?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface InventoryLineRepository {
  /**
   * One transaction: locks product then inventory (404 / PRODUCT_INACTIVE / INVENTORY_INACTIVE),
   * inserts the line with current = initial and the `created` history row. Throws 409
   * INVENTORY_LINE_DUPLICATE / INVENTORY_LINE_ID_TAKEN (race-safe).
   */
  create(
    inventoryId: string,
    data: NewInventoryLine,
    actorId: string,
    id?: string,
  ): Promise<InventoryLine>;
  findById(id: string): Promise<InventoryLine | null>;
  listByInventory(
    inventoryId: string,
    filter: InventoryLineFilter,
  ): Promise<{ items: InventoryLine[]; total: number }>;
  /**
   * One transaction with locks (product, inventory, line). Changing the initial quantity moves the
   * current one by the same difference (409 QUANTITY_BELOW_ZERO when it would be negative) and
   * adds an `initial_adjusted` history row.
   */
  update(
    id: string,
    changes: Partial<InventoryLineData>,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<InventoryLine>>;
  /** Activation requires an active inventory and product; deactivation is always allowed. */
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<InventoryLine>>;
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<InventoryLine>>;
  /** Most recent first. */
  listHistory(
    lineId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: LineHistoryEntry[]; total: number }>;
}
