import {
  changedLineFields,
  initialChanged,
  normalizeLineChanges,
  normalizeNewLine,
  type InventoryLine,
  type InventoryLineChanges,
  type InventoryLineInput,
  type LineHistoryEntry,
} from '../../domain/inventory-line/inventory-line.js';
import type {
  InventoryLineFilter,
  InventoryLineRepository,
} from '../../domain/inventory-line/inventory-line-repository.js';
import type { InventoryRepository } from '../../domain/inventory/inventory-repository.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { subtractDecimal, QUANTITY_SCALE } from '../../domain/shared/decimal.js';
import { notFoundError, validationError } from '../../domain/shared/errors.js';
import { ResourceUseCases } from '../shared/resource-use-cases.js';

/** Inventory line use cases. Every write records an audit event with `lineId` and `actorId`. */
export class InventoryLineUseCases extends ResourceUseCases<InventoryLine> {
  constructor(
    private readonly lines: InventoryLineRepository,
    private readonly inventories: InventoryRepository,
    log: AuditLog,
    now: () => Date = () => new Date(),
  ) {
    super(
      lines,
      log,
      {
        event: 'inventory_line',
        idKey: 'lineId',
        notFound: 'Línea de inventario no encontrada',
        versionConflict: 'La línea cambió en el servidor; revisa la versión actual',
      },
      now,
    );
  }

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(
    actorId: string,
    inventoryId: string,
    input: InventoryLineInput,
    id?: string,
  ): Promise<InventoryLine> {
    const data = normalizeNewLine(input);
    // Id uniqueness is detected last, by the repository, after the parent checks (spec §6).
    const created = await this.lines.create(inventoryId, data, actorId, id);
    this.event('created', created.id, actorId, { inventoryId });
    return created;
  }

  /** Lines of an inventory (404 when the inventory does not exist). */
  async listByInventory(
    inventoryId: string,
    filter: InventoryLineFilter,
  ): Promise<{ items: InventoryLine[]; total: number }> {
    if (!(await this.inventories.findById(inventoryId))) {
      throw notFoundError('Inventario no encontrado');
    }
    return this.lines.listByInventory(inventoryId, filter);
  }

  /** `expectedVersion` (If-Match) makes the edit conditional; a stale one is a 409 VERSION_CONFLICT. */
  async update(
    actorId: string,
    id: string,
    input: InventoryLineChanges,
    expectedVersion?: number,
  ): Promise<InventoryLine> {
    const changes = normalizeLineChanges(input);
    if (Object.keys(changes).length === 0) {
      throw validationError('Indica al menos un campo a modificar');
    }
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    const outcome = await this.lines.update(id, changes, actorId, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event('updated', id, actorId, { fields: changedLineFields(current, changes) });
    if (initialChanged(current, changes)) {
      this.event('quantity_adjusted', id, actorId, {
        delta: subtractDecimal(updated.quantityInitial, current.quantityInitial, QUANTITY_SCALE),
      });
    }
    return updated;
  }

  /** Idempotent: asking for the current state answers the line without an event. */
  async setStatus(
    actorId: string,
    id: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<InventoryLine> {
    const current = await this.get(id);
    this.assertVersion(actorId, current, expectedVersion);
    if (current.isActive === isActive) return current;
    const outcome = await this.lines.setActive(id, isActive, this.now(), expectedVersion);
    const updated = this.unwrap(actorId, id, expectedVersion, outcome);
    this.event(isActive ? 'activated' : 'deactivated', id, actorId);
    return updated;
  }

  /** Quantity history of a line (404 when it does not exist), most recent first. */
  async history(
    id: string,
    limit: number,
    offset: number,
  ): Promise<{ items: LineHistoryEntry[]; total: number }> {
    await this.get(id);
    return this.lines.listHistory(id, limit, offset);
  }
}
