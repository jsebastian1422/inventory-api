import type { SalePermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { SaleUseCases } from '../../application/sales/sale.use-cases.js';
import type { CustomerInput, Sale, SaleItem } from '../../domain/sale/sale.js';
import { customerLabel } from '../../domain/sale/sale.js';
import type { Actor } from '../../domain/scope/scope.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import { presentCart } from './carts.controller.js';
import { Idempotent, type ReplayAuthorization } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  checkoutSchema,
  idSchema,
  listChangesQuerySchema,
  listSalesQuerySchema,
} from './schemas.js';
import { SALE_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_CREATE = 'sales.create' satisfies SalePermission;

/** Replay of a checkout: same checks as a new one (permission, owner, live scope, establishment state). */
const REPLAY_CHECKOUT: ReplayAuthorization<SaleUseCases> = {
  token: SALE_USE_CASES,
  check: (uc, actor, request) =>
    uc.authorizeCheckout(actor, (request.params as { id: string }).id.toLowerCase()),
};

const idPipe = new ZodValidationPipe(idSchema);

function presentItem(i: SaleItem) {
  return {
    id: i.id,
    inventoryLineId: i.inventoryLineId,
    productId: i.productId,
    sku: i.sku,
    productName: i.productName,
    unit: i.unit,
    barcode: i.barcode,
    expiresOn: i.expiresOn,
    unitPrice: i.unitPrice,
    quantity: i.quantity,
    subtotal: i.subtotal,
  };
}

/** Public representation of a sale (internal invoice); amounts and quantities as text. */
export function presentSale(s: Sale) {
  return {
    id: s.id,
    number: s.number,
    establishmentId: s.establishmentId,
    cartId: s.cartId,
    sellerId: s.sellerId,
    customer: s.customer,
    customerLabel: customerLabel(s),
    items: s.items.map(presentItem),
    total: s.total,
    createdAt: s.createdAt,
    version: s.version,
  };
}

/** Sales: checkout of a cart (`POST /carts/:id/checkout`) and their queries (sprint 008). */
@Controller()
export class SalesController {
  constructor(@Inject(SALE_USE_CASES) private readonly uc: SaleUseCases) {}

  /** 201 with the invoice. `sales.create`, ownership and scope are rechecked on every replay. */
  @Post('carts/:id/checkout')
  @RequirePermissions(PERM_CREATE)
  @Idempotent({ authorize: REPLAY_CHECKOUT })
  async checkout(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(checkoutSchema))
    body: { id?: string; customer?: CustomerInput | null },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentSale(
      await presentingConflict(this.uc.checkout(actor, id, body, expectedVersion), presentCart),
    );
  }

  /** Own sales (`sales.create`) and those of the scope (`sales.read`): checked by the use case. */
  @Get('sales')
  @RequirePermissions()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listSalesQuerySchema))
    query: {
      establishmentId?: string;
      sellerId?: string;
      from?: string;
      to?: string;
      limit: number;
      offset: number;
    },
  ) {
    const { items, total } = await this.uc.list(actor, query);
    return { items: items.map(presentSale), total, limit: query.limit, offset: query.offset };
  }

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('sales/changes')
  @RequirePermissions(PERM_CREATE)
  async changes(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.changes(actor, query.cursor, query.limit);
    return {
      items: page.items.map(presentSale),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /** The seller (`sales.create`) or who reads the establishment (`sales.read`); otherwise 404. */
  @Get('sales/:id')
  @RequirePermissions()
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return presentSale(await this.uc.get(actor, id));
  }
}
