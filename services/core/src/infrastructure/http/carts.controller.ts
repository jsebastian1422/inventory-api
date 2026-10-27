import type { CartPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { CartUseCases } from '../../application/carts/cart.use-cases.js';
import type { Cart, CartDetail, CartStatus } from '../../domain/cart/cart.js';
import type { CartItem } from '../../domain/cart-item/cart-item.js';
import type { Actor } from '../../domain/scope/scope.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import { Idempotent, type ReplayAuthorization } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  addCartItemSchema,
  cartStatusSchema,
  createCartSchema,
  idSchema,
  listCartsQuerySchema,
  listChangesQuerySchema,
} from './schemas.js';
import { CART_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_USE = 'carts.use' satisfies CartPermission;

/** Replay of a cart write: same checks as a new one (owner, `carts.use`, scope, establishment state). */
const REPLAY_CART_WRITE: ReplayAuthorization<CartUseCases> = {
  token: CART_USE_CASES,
  check: (uc, actor, request) =>
    uc.authorizeCartWrite(actor, (request.params as { id: string }).id.toLowerCase()),
};

const idPipe = new ZodValidationPipe(idSchema);

export function presentCart(c: Cart) {
  return {
    id: c.id,
    establishmentId: c.establishmentId,
    createdBy: c.createdBy,
    status: c.status,
    cancelledBy: c.cancelledBy,
    cancelledAt: c.cancelledAt,
    version: c.version,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function presentCartItem(i: CartItem) {
  return {
    id: i.id,
    cartId: i.cartId,
    inventoryLineId: i.inventoryLineId,
    quantity: i.quantity,
    isActive: i.isActive,
    version: i.version,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

/** Header plus the active items with product, lot, subtotal and availability, and the total. */
function presentDetail(d: CartDetail) {
  return {
    ...presentCart(d.cart),
    items: d.items.map((item) => ({
      id: item.id,
      version: item.version,
      product: item.product,
      line: item.line,
      quantity: item.quantity,
      subtotal: item.subtotal,
      available: item.available,
      unavailableReason: item.unavailableReason,
    })),
    total: d.total,
    unavailableCount: d.unavailableCount,
  };
}

/** Carts of the user (ADR-0002 offline protocol; access rules of the sprint 007 spec 3.1). */
@Controller('carts')
export class CartsController {
  constructor(@Inject(CART_USE_CASES) private readonly uc: CartUseCases) {}

  @Post()
  @RequirePermissions(PERM_USE)
  @Idempotent()
  async create(
    @CurrentActor() actor: Actor,
    @Body(new ZodValidationPipe(createCartSchema)) body: { id?: string; establishmentId: string },
  ) {
    return presentCart(await this.uc.create(actor, body.establishmentId, body.id));
  }

  /** Own carts (`carts.use`) or those of `userId` (`carts.read` + `establishments.all`): checked by the use case. */
  @Get()
  @RequirePermissions()
  async list(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listCartsQuerySchema))
    query: {
      status?: CartStatus;
      establishmentId?: string;
      userId?: string;
      limit: number;
      offset: number;
    },
  ) {
    const { items, total } = await this.uc.list(actor, query);
    return { items: items.map(presentCart), total, limit: query.limit, offset: query.offset };
  }

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('changes')
  @RequirePermissions(PERM_USE)
  async changes(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.cartChanges(actor, query.cursor, query.limit);
    return {
      items: page.items.map(presentCart),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /** Own cart (`carts.use`) or foreign one for `carts.read` + `establishments.all`: checked by the use case. */
  @Get(':id')
  @RequirePermissions()
  async get(@CurrentActor() actor: Actor, @Param('id', idPipe) id: string) {
    return presentDetail(await this.uc.get(actor, id));
  }

  /** `carts.use` of the owner and CART_READ_ONLY for readers are checked by the use case (R-4). */
  @Patch(':id/status')
  @RequirePermissions()
  @Idempotent({ authorize: REPLAY_CART_WRITE })
  async cancel(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(cartStatusSchema)) _body: { status: 'cancelled' },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentCart(
      await presentingConflict(this.uc.cancel(actor, id, expectedVersion), presentCart),
    );
  }

  /** 201 for a new item, 200 when the quantity was added to an existing one or it was reactivated. */
  @Post(':id/items')
  @RequirePermissions()
  @Idempotent({ authorize: REPLAY_CART_WRITE })
  async addItem(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(addCartItemSchema))
    body: { id?: string; inventoryLineId: string; quantity: string },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { item, created } = await this.uc.addItem(actor, id, body, body.id);
    void reply.code(created ? 201 : 200);
    return presentCartItem(item);
  }
}
