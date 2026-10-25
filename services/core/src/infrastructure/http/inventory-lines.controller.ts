import type { InventoryPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import type { InventoryLineUseCases } from '../../application/inventory-lines/inventory-line.use-cases.js';
import type {
  InventoryLine,
  InventoryLineChanges,
  LineHistoryEntry,
} from '../../domain/inventory-line/inventory-line.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import { Idempotent } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  establishmentStatusSchema,
  idSchema,
  listChangesQuerySchema,
  pageQuerySchema,
  updateInventoryLineSchema,
} from './schemas.js';
import { INVENTORY_LINE_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'inventories.read' satisfies InventoryPermission;
const PERM_UPDATE = 'inventories.update' satisfies InventoryPermission;
const PERM_DEACTIVATE = 'inventories.deactivate' satisfies InventoryPermission;

const idPipe = new ZodValidationPipe(idSchema);

/** Public representation of a line (also used by `/inventories/:id/lines`). */
export function presentLine(l: InventoryLine) {
  return {
    id: l.id,
    inventoryId: l.inventoryId,
    productId: l.productId,
    barcode: l.barcode,
    expiresOn: l.expiresOn,
    quantityInitial: l.quantityInitial,
    quantityAlert: l.quantityAlert,
    quantityCurrent: l.quantityCurrent,
    isActive: l.isActive,
    version: l.version,
    createdAt: l.createdAt,
    updatedAt: l.updatedAt,
  };
}

function presentHistory(h: LineHistoryEntry) {
  return {
    reason: h.reason,
    initialBefore: h.initialBefore,
    initialAfter: h.initialAfter,
    currentBefore: h.currentBefore,
    currentAfter: h.currentAfter,
    delta: h.delta,
    actorId: h.actorId,
    changedAt: h.changedAt,
  };
}

@Controller('inventory-lines')
export class InventoryLinesController {
  constructor(@Inject(INVENTORY_LINE_USE_CASES) private readonly uc: InventoryLineUseCases) {}

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('changes')
  @RequirePermissions(PERM_READ)
  async changes(
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.listChanges(query.cursor, query.limit);
    return {
      items: page.items.map(presentLine),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  @Get(':id')
  @RequirePermissions(PERM_READ)
  async get(@Param('id', idPipe) id: string) {
    return presentLine(await this.uc.get(id));
  }

  @Get(':id/history')
  @RequirePermissions(PERM_READ)
  async history(
    @Param('id', idPipe) id: string,
    @Query(new ZodValidationPipe(pageQuerySchema)) query: { limit: number; offset: number },
  ) {
    const { items, total } = await this.uc.history(id, query.limit, query.offset);
    return { items: items.map(presentHistory), total, limit: query.limit, offset: query.offset };
  }

  @Patch(':id')
  @RequirePermissions(PERM_UPDATE)
  @Idempotent()
  async update(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateInventoryLineSchema)) body: InventoryLineChanges,
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentLine(
      await presentingConflict(this.uc.update(actorId, id, body, expectedVersion), presentLine),
    );
  }

  @Patch(':id/status')
  @RequirePermissions(PERM_DEACTIVATE)
  @Idempotent()
  async setStatus(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(establishmentStatusSchema)) body: { isActive: boolean },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentLine(
      await presentingConflict(
        this.uc.setStatus(actorId, id, body.isActive, expectedVersion),
        presentLine,
      ),
    );
  }
}
