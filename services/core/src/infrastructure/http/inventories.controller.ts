import type { InventoryPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import type { InventoryUseCases } from '../../application/inventories/inventory.use-cases.js';
import type { InventoryLineUseCases } from '../../application/inventory-lines/inventory-line.use-cases.js';
import type { StatusFilter } from '../../domain/establishment/establishment-repository.js';
import type {
  Inventory,
  InventoryChanges,
  InventoryInput,
} from '../../domain/inventory/inventory.js';
import type { InventoryLineInput } from '../../domain/inventory-line/inventory-line.js';
import { CurrentUserId, RequirePermissions } from './auth-decorators.js';
import { Idempotent } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentLine } from './inventory-lines.controller.js';
import { presentingConflict } from './present.js';
import {
  createInventoryLineSchema,
  createInventorySchema,
  establishmentStatusSchema,
  idSchema,
  listChangesQuerySchema,
  listInventoriesQuerySchema,
  listInventoryLinesQuerySchema,
  updateInventorySchema,
} from './schemas.js';
import { INVENTORY_LINE_USE_CASES, INVENTORY_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_READ = 'inventories.read' satisfies InventoryPermission;
const PERM_CREATE = 'inventories.create' satisfies InventoryPermission;
const PERM_UPDATE = 'inventories.update' satisfies InventoryPermission;
const PERM_DEACTIVATE = 'inventories.deactivate' satisfies InventoryPermission;

const idPipe = new ZodValidationPipe(idSchema);

function present(i: Inventory) {
  return {
    id: i.id,
    establishmentId: i.establishmentId,
    name: i.name,
    startDate: i.startDate,
    endDate: i.endDate,
    origin: i.origin,
    notes: i.notes,
    isActive: i.isActive,
    version: i.version,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

@Controller('inventories')
export class InventoriesController {
  constructor(
    @Inject(INVENTORY_USE_CASES) private readonly uc: InventoryUseCases,
    @Inject(INVENTORY_LINE_USE_CASES) private readonly lines: InventoryLineUseCases,
  ) {}

  @Post()
  @RequirePermissions(PERM_CREATE)
  @Idempotent()
  async create(
    @CurrentUserId() actorId: string,
    @Body(new ZodValidationPipe(createInventorySchema)) body: InventoryInput & { id?: string },
  ) {
    const { id, ...input } = body;
    return present(await this.uc.create(actorId, input, id));
  }

  @Get()
  @RequirePermissions(PERM_READ)
  async list(
    @Query(new ZodValidationPipe(listInventoriesQuerySchema))
    query: {
      status: StatusFilter;
      q?: string;
      establishmentId?: string;
      limit: number;
      offset: number;
    },
  ) {
    const { items, total } = await this.uc.list(query);
    return { items: items.map(present), total, limit: query.limit, offset: query.offset };
  }

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('changes')
  @RequirePermissions(PERM_READ)
  async changes(
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.listChanges(query.cursor, query.limit);
    return { items: page.items.map(present), nextCursor: page.nextCursor, hasMore: page.hasMore };
  }

  @Get(':id')
  @RequirePermissions(PERM_READ)
  async get(@Param('id', idPipe) id: string) {
    return present(await this.uc.get(id));
  }

  @Patch(':id')
  @RequirePermissions(PERM_UPDATE)
  @Idempotent()
  async update(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateInventorySchema)) body: InventoryChanges,
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return present(
      await presentingConflict(this.uc.update(actorId, id, body, expectedVersion), present),
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
    return present(
      await presentingConflict(
        this.uc.setStatus(actorId, id, body.isActive, expectedVersion),
        present,
      ),
    );
  }

  /** The detail is managed with the permissions of `inventories`. */
  @Post(':id/lines')
  @RequirePermissions(PERM_UPDATE)
  @Idempotent()
  async createLine(
    @CurrentUserId() actorId: string,
    @Param('id', idPipe) inventoryId: string,
    @Body(new ZodValidationPipe(createInventoryLineSchema))
    body: InventoryLineInput & { id?: string },
  ) {
    const { id, ...input } = body;
    return presentLine(await this.lines.create(actorId, inventoryId, input, id));
  }

  @Get(':id/lines')
  @RequirePermissions(PERM_READ)
  async listLines(
    @Param('id', idPipe) inventoryId: string,
    @Query(new ZodValidationPipe(listInventoryLinesQuerySchema))
    query: {
      status: StatusFilter;
      productId?: string;
      barcode?: string;
      limit: number;
      offset: number;
    },
  ) {
    const { items, total } = await this.lines.listByInventory(inventoryId, query);
    return { items: items.map(presentLine), total, limit: query.limit, offset: query.offset };
  }
}
