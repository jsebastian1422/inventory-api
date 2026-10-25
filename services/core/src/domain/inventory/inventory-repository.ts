import type { StatusFilter } from '../establishment/establishment-repository.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { WriteOutcome } from '../sync/version.js';
import type { Inventory, InventoryData } from './inventory.js';

export interface InventoryFilter {
  readonly status: StatusFilter;
  readonly establishmentId?: string;
  /** Free text matched against the name (case-insensitive, literal). */
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface InventoryRepository {
  /**
   * Locks the establishment (404 / 409 ESTABLISHMENT_INACTIVE) and inserts. Throws 409
   * INVENTORY_ID_TAKEN when the id is used (race-safe).
   */
  create(data: InventoryData, id?: string): Promise<Inventory>;
  findById(id: string): Promise<Inventory | null>;
  /** Ordered by start date (newest first), then name and id. */
  list(filter: InventoryFilter): Promise<{ items: Inventory[]; total: number }>;
  /** Conditional update by version; a different establishment must exist and be active. */
  update(
    id: string,
    changes: Partial<InventoryData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Inventory>>;
  /**
   * Activation requires an active establishment (409 ESTABLISHMENT_INACTIVE) and then that no active
   * line has an inactive product (409 INVENTORY_HAS_INACTIVE_PRODUCTS, `details` = [{lineId, productId}]);
   * locks establishment, then products, then the inventory.
   */
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Inventory>>;
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Inventory>>;
}
