import type { CartPermission } from '@inventory/shared';
import { Body, Controller, Get, Inject, Param, Patch, Query } from '@nestjs/common';
import type { CartUseCases } from '../../application/carts/cart.use-cases.js';
import type { Actor } from '../../domain/scope/scope.js';
import { CurrentActor, RequirePermissions } from './auth-decorators.js';
import { presentCartItem } from './carts.controller.js';
import { Idempotent, type ReplayAuthorization } from './idempotency.interceptor.js';
import { IfMatchVersion } from './if-match.js';
import { presentingConflict } from './present.js';
import {
  establishmentStatusSchema,
  idSchema,
  listChangesQuerySchema,
  updateCartItemSchema,
} from './schemas.js';
import { CART_USE_CASES } from './tokens.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const PERM_USE = 'carts.use' satisfies CartPermission;

/** Replay of an item write: same checks as a new one (owner, `carts.use`, scope, establishment state). */
const REPLAY_ITEM_WRITE: ReplayAuthorization<CartUseCases> = {
  token: CART_USE_CASES,
  check: (uc, actor, request) =>
    uc.authorizeItemWrite(actor, (request.params as { id: string }).id.toLowerCase()),
};

const idPipe = new ZodValidationPipe(idSchema);

/** Items of the user's carts (creation is `POST /carts/:id/items`). */
@Controller('cart-items')
export class CartItemsController {
  constructor(@Inject(CART_USE_CASES) private readonly uc: CartUseCases) {}

  /** Registered before `:id` so that `changes` is not taken as an id. */
  @Get('changes')
  @RequirePermissions(PERM_USE)
  async changes(
    @CurrentActor() actor: Actor,
    @Query(new ZodValidationPipe(listChangesQuerySchema)) query: { cursor?: string; limit: number },
  ) {
    const page = await this.uc.itemChanges(actor, query.cursor, query.limit);
    return {
      items: page.items.map(presentCartItem),
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
    };
  }

  /** Permissions (`carts.use`, read-only readers) are checked by the use case, as in `carts`. */
  @Patch(':id')
  @RequirePermissions()
  @Idempotent({ authorize: REPLAY_ITEM_WRITE })
  async update(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(updateCartItemSchema)) body: { quantity: string },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentCartItem(
      await presentingConflict(
        this.uc.changeQuantity(actor, id, body.quantity, expectedVersion),
        presentCartItem,
      ),
    );
  }

  @Patch(':id/status')
  @RequirePermissions()
  @Idempotent({ authorize: REPLAY_ITEM_WRITE })
  async setStatus(
    @CurrentActor() actor: Actor,
    @Param('id', idPipe) id: string,
    @Body(new ZodValidationPipe(establishmentStatusSchema)) body: { isActive: boolean },
    @IfMatchVersion() expectedVersion: number | undefined,
  ) {
    return presentCartItem(
      await presentingConflict(
        this.uc.setItemActive(actor, id, body.isActive, expectedVersion),
        presentCartItem,
      ),
    );
  }
}
