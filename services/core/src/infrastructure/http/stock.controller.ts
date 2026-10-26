import type { StockPermission } from '@inventory/shared';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { StockUseCases } from '../../application/stock/stock.use-cases.js';
import type { Actor, ScopedRecord } from '../../domain/scope/scope.js';
import type { StockResult } from '../../domain/stock/stock.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import { present as presentInventory } from './inventories.controller.js';
import { presentLine } from './inventory-lines.controller.js';
import { present as presentProduct } from './products.controller.js';
import { listChangesQuerySchema, stockSearchQuerySchema } from './schemas.js';
import { STOCK_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_SEARCH = 'stock.search' satisfies StockPermission;

const changesPipe = new ZodValidationPipe(listChangesQuerySchema);

interface ChangesQuery {
  cursor?: string;
  limit: number;
}

/** Complete representation in scope; outside it ONLY `{ id, inScope: false }` (ADR-0004). */
function scoped<T>(present: (value: T) => unknown) {
  return (record: ScopedRecord<T>) =>
    record.inScope ? present(record.value) : { id: record.id, inScope: false as const };
}

function presentResult(r: StockResult) {
  return {
    lineId: r.lineId,
    inventoryId: r.inventoryId,
    inventoryName: r.inventoryName,
    barcode: r.barcode,
    expiresOn: r.expiresOn,
    quantityCurrent: r.quantityCurrent,
    product: r.product,
  };
}

/** Stock search by establishment and offline feeds with scope (ADR-0004). */
@Controller('stock')
export class StockController {
  constructor(@Inject(STOCK_USE_CASES) private readonly uc: StockUseCases) {}

  @Get('search')
  @RequirePermissions(PERM_SEARCH)
  async search(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(stockSearchQuerySchema))
    query: { establishmentId: string; barcode?: string; q?: string; limit: number; offset: number },
  ) {
    const criteria = query.barcode !== undefined ? { barcode: query.barcode } : { q: query.q! };
    const { items, total } = await this.uc.search(
      actor,
      query.establishmentId,
      criteria,
      query.limit,
      query.offset,
    );
    return { items: items.map(presentResult), total, limit: query.limit, offset: query.offset };
  }

  @Get('inventories/changes')
  @RequirePermissions(PERM_SEARCH)
  async inventoryChanges(@CurrentActor() actor: Actor, @Query(changesPipe) query: ChangesQuery) {
    const page = await this.uc.inventoryChanges(actor, query.cursor, query.limit);
    return {
      items: page.items.map(scoped(presentInventory)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  @Get('lines/changes')
  @RequirePermissions(PERM_SEARCH)
  async lineChanges(@CurrentActor() actor: Actor, @Query(changesPipe) query: ChangesQuery) {
    const page = await this.uc.lineChanges(actor, query.cursor, query.limit);
    return {
      items: page.items.map(scoped(presentLine)),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  @Get('products/changes')
  @RequirePermissions(PERM_SEARCH)
  async productChanges(@Query(changesPipe) query: ChangesQuery) {
    const page = await this.uc.productChanges(query.cursor, query.limit);
    return {
      items: page.items.map(presentProduct),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }
}
