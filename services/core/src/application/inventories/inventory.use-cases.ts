import {
  assertEditedDates,
  changedInventoryFields,
  normalizeInventoryChanges,
  normalizeNewInventory,
  type Inventory,
  type InventoryChanges,
  type InventoryInput,
} from '../../domain/inventory/inventory.js';
import type {
  InventoryFilter,
  InventoryRepository,
} from '../../domain/inventory/inventory-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { validationError } from '../../domain/shared/errors.js';
import { ResourceUseCases } from '../shared/resource-use-cases.js';

/** Inventory (header) use cases. Every write records an audit event with `inventoryId` and `actorId`. */
export class InventoryUseCases extends ResourceUseCases<Inventory> {
  constructor(
    private readonly inventories: InventoryRepository,
    log: AuditLog,
    now: () => Date = () => new Date(),
  ) {
    super(
      inventories,
      log,
      {
        event: 'inventory',
        idKey: 'inventoryId',
        notFound: 'Inventario no encontrado',
        versionConflict: 'El inventario cambió en el servidor; revisa la versión actual',
      },
      now,
    );
  }

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(actorId: string, input: InventoryInput, id?: string): Promise<Inventory> {
    const data = normalizeNewInventory(input);
    // Id uniqueness is detected last, by the repository, after the establishment checks (spec §6).
    const created = await this.inventories.create(data, id);
    this.event('created', created.id, actorId);
    return created;
  }

  list(filter: InventoryFilter): Promise<{ items: Inventory[]; total: number }> {
    return this.inventories.list(filter);
  }

  /** `expectedVersion` (If-Match) makes the edit conditional; a stale one is a 409 VERSION_CONFLICT. */
  async update(
    actorId: string,
    id: string,
    input: InventoryChanges,
    expectedVersion?: number,
  ): Promise<Inventory> {
    const changes = normalizeInventoryChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    assertEditedDates(current, changes);
    const outcome = await this.inventories.update(id, changes, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event('updated', id, actorId, { fields: changedInventoryFields(current, changes) });
    return updated;
  }

  /** Idempotent: asking for the current state answers the inventory without an event. */
  async setStatus(
    actorId: string,
    id: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<Inventory> {
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (current.isActive === isActive) return current;
    const outcome = await this.inventories.setActive(id, isActive, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event(isActive ? 'activated' : 'deactivated', id, actorId);
    return updated;
  }
}
