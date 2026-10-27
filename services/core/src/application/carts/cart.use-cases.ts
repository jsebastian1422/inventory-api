import {
  cartAccess,
  cartNotFoundError,
  canReadOthersCarts,
  PERM_CART_USE,
  type Cart,
  type CartDetail,
  type CartStatus,
} from '../../domain/cart/cart.js';
import type { CartRepository, EffectiveOutcome } from '../../domain/cart/cart-repository.js';
import {
  cartItemNotFoundError,
  positiveQuantity,
  type CartItem,
} from '../../domain/cart-item/cart-item.js';
import type { CartItemRepository } from '../../domain/cart-item/cart-item-repository.js';
import type { Actor } from '../../domain/scope/scope.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, forbiddenError } from '../../domain/shared/errors.js';
import {
  decodeCursor,
  encodeCursor,
  type ChangeBatch,
  type ChangeCursor,
  type ChangePage,
} from '../../domain/sync/change-cursor.js';
import type { ScopeUseCases } from '../scope/scope.use-cases.js';

export interface CartListQuery {
  /** Owner to list; defaults to the actor. Another user needs `carts.read` + `establishments.all`. */
  readonly userId?: string;
  readonly status?: CartStatus;
  readonly establishmentId?: string;
  readonly limit: number;
  readonly offset: number;
}

const DENIED = 'No tienes permiso para realizar esta acción';

const readOnlyError = () => forbiddenError('Solo puedes consultar este carrito', 'CART_READ_ONLY');

/**
 * Carts and their items (sprint 007). Writes require the owner, `carts.use` and the establishment
 * in the live scope (ADR-0004); a reader of foreign carts (`carts.read` + `establishments.all`) gets
 * 403 CART_READ_ONLY on writes. Every effective write records an audit event with `cartId` and
 * `actorId` (and `itemId` for items).
 */
export class CartUseCases {
  constructor(
    private readonly carts: CartRepository,
    private readonly items: CartItemRepository,
    private readonly scope: ScopeUseCases,
    private readonly log: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** `id` is the optional client-generated identifier (offline creation). */
  async create(actor: Actor, establishmentId: string, id?: string): Promise<Cart> {
    // Order: establishment 404 -> inactive 409 -> outside the scope 403 (live), then id uniqueness.
    await this.scope.assertInScope(actor, establishmentId);
    const cart = await this.carts.create(establishmentId, actor.userId, id);
    this.log.info('cart.created', { cartId: cart.id, actorId: actor.userId, establishmentId });
    return cart;
  }

  /** Own carts, or those of `userId` for who may read foreign ones (403 otherwise). */
  async list(actor: Actor, query: CartListQuery): Promise<{ items: Cart[]; total: number }> {
    const owner = query.userId ?? actor.userId;
    if (owner.toLowerCase() === actor.userId.toLowerCase()) this.assertUse(actor);
    else if (!canReadOthersCarts(actor)) throw forbiddenError(DENIED);
    return this.carts.list({
      createdBy: owner,
      status: query.status,
      establishmentId: query.establishmentId,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** Own cart (`carts.use`) or foreign one for a reader; otherwise 404 CART_NOT_FOUND. */
  async get(actor: Actor, id: string): Promise<CartDetail> {
    cartAccess(await this.carts.findById(id), actor, cartNotFoundError, true);
    const detail = await this.carts.findDetail(id);
    if (!detail) throw cartNotFoundError();
    return detail;
  }

  /**
   * Authorization of a replayed `POST /carts/:id/items` or `PATCH /carts/:id/status`: the same
   * checks as a new write (404, read only, `carts.use`, scope), without executing it.
   */
  async authorizeCartWrite(actor: Actor, id: string): Promise<void> {
    await this.writableCart(actor, id);
  }

  /** Same as `authorizeCartWrite` for the replay of an item write (`PATCH /cart-items/:id[/status]`). */
  async authorizeItemWrite(actor: Actor, itemId: string): Promise<void> {
    await this.writableItem(actor, itemId);
  }

  /** Idempotent: an already cancelled cart is answered unchanged and without an event. */
  async cancel(actor: Actor, id: string, expectedVersion?: number): Promise<Cart> {
    const current = await this.writableCart(actor, id);
    this.assertCartVersion(actor, current, expectedVersion);
    const outcome = await this.carts.cancel(id, actor.userId, this.now(), expectedVersion);
    const { value, changed } = this.unwrapCart(actor, id, expectedVersion, outcome);
    if (changed) this.log.info('cart.cancelled', { cartId: id, actorId: actor.userId });
    return value;
  }

  /** 201 for a new item, 200 (`created: false`) when the quantity was added or the item reactivated. */
  async addItem(
    actor: Actor,
    cartId: string,
    input: { inventoryLineId: string; quantity: unknown },
    id?: string,
  ): Promise<{ item: CartItem; created: boolean }> {
    const quantity = positiveQuantity(input.quantity);
    await this.writableCart(actor, cartId);
    const result = await this.items.add(
      cartId,
      { inventoryLineId: input.inventoryLineId, quantity },
      this.now(),
      id,
    );
    this.itemEvent(result.reactivated ? 'reactivated' : 'added', actor, result.item, {
      inventoryLineId: input.inventoryLineId,
      quantity,
    });
    return { item: result.item, created: result.created };
  }

  /** Sets the quantity (does not add). Unchanged quantity: answered without a new version. */
  async changeQuantity(
    actor: Actor,
    itemId: string,
    quantityInput: unknown,
    expectedVersion?: number,
  ): Promise<CartItem> {
    const quantity = positiveQuantity(quantityInput);
    const current = await this.writableItem(actor, itemId);
    this.assertItemVersion(actor, current, expectedVersion);
    const outcome = await this.items.setQuantity(itemId, quantity, this.now(), expectedVersion);
    const { value, changed } = this.unwrapItem(actor, current, expectedVersion, outcome);
    if (changed) this.itemEvent('updated', actor, value, { quantity: value.quantity });
    return value;
  }

  /** Idempotent: asking for the current state answers the item without an event. */
  async setItemActive(
    actor: Actor,
    itemId: string,
    isActive: boolean,
    expectedVersion?: number,
  ): Promise<CartItem> {
    const current = await this.writableItem(actor, itemId);
    this.assertItemVersion(actor, current, expectedVersion);
    const outcome = await this.items.setActive(itemId, isActive, this.now(), expectedVersion);
    const { value, changed } = this.unwrapItem(actor, current, expectedVersion, outcome);
    if (changed) this.itemEvent(isActive ? 'reactivated' : 'removed', actor, value);
    return value;
  }

  /** Feed of the carts created by the actor (ADR-0002); 400 when the cursor is malformed. */
  async cartChanges(
    actor: Actor,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChangePage<Cart>> {
    this.assertUse(actor);
    const from = cursor === undefined ? null : decodeCursor(cursor);
    return toPage(from, await this.carts.listChanges(from, limit, actor.userId));
  }

  /** Feed of the items of the carts created by the actor (ADR-0002). */
  async itemChanges(
    actor: Actor,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChangePage<CartItem>> {
    this.assertUse(actor);
    const from = cursor === undefined ? null : decodeCursor(cursor);
    return toPage(from, await this.items.listChanges(from, limit, actor.userId));
  }

  private assertUse(actor: Actor): void {
    if (!actor.permissions.includes(PERM_CART_USE)) throw forbiddenError(DENIED);
  }

  /** 404 -> 403 (read only / scope): the cart the actor may write to. */
  private async writableCart(actor: Actor, id: string): Promise<Cart> {
    const cart = await this.carts.findById(id);
    if (cartAccess(cart, actor) === 'reader') throw readOnlyError();
    await this.scope.assertInScope(actor, cart!.establishmentId);
    return cart!;
  }

  /** Same as `writableCart` for an item; a cart that is not the actor's is `CART_ITEM_NOT_FOUND`. */
  private async writableItem(actor: Actor, itemId: string): Promise<CartItem> {
    const item = await this.items.findById(itemId);
    if (!item) throw cartItemNotFoundError();
    const cart = await this.carts.findById(item.cartId);
    if (cartAccess(cart, actor, cartItemNotFoundError) === 'reader') throw readOnlyError();
    await this.scope.assertInScope(actor, cart!.establishmentId);
    return item;
  }

  private assertCartVersion(actor: Actor, current: Cart, expected?: number): void {
    if (expected !== undefined && current.version !== expected) {
      throw this.cartConflict(actor, current, expected);
    }
  }

  private assertItemVersion(actor: Actor, current: CartItem, expected?: number): void {
    if (expected !== undefined && current.version !== expected) {
      throw this.itemConflict(actor, current, expected);
    }
  }

  private unwrapCart(
    actor: Actor,
    id: string,
    expected: number | undefined,
    outcome: EffectiveOutcome<Cart>,
  ): { value: Cart; changed: boolean } {
    if (outcome.status === 'updated') return outcome;
    if (outcome.status === 'not_found') throw cartNotFoundError();
    throw this.cartConflict(actor, outcome.current, expected, id);
  }

  private unwrapItem(
    actor: Actor,
    item: CartItem,
    expected: number | undefined,
    outcome: EffectiveOutcome<CartItem>,
  ): { value: CartItem; changed: boolean } {
    if (outcome.status === 'updated') return outcome;
    if (outcome.status === 'not_found') throw cartItemNotFoundError();
    throw this.itemConflict(actor, outcome.current, expected, item.id);
  }

  private cartConflict(actor: Actor, current: Cart, expected?: number, id = current.id) {
    this.log.warn('cart.version_conflict', {
      cartId: id,
      actorId: actor.userId,
      expectedVersion: expected,
      currentVersion: current.version,
    });
    return conflictError(
      'El carrito cambió en el servidor; revisa la versión actual',
      'VERSION_CONFLICT',
      { current },
    );
  }

  private itemConflict(actor: Actor, current: CartItem, expected?: number, id = current.id) {
    this.log.warn('cart_item.version_conflict', {
      cartId: current.cartId,
      itemId: id,
      actorId: actor.userId,
      expectedVersion: expected,
      currentVersion: current.version,
    });
    return conflictError(
      'El ítem cambió en el servidor; revisa la versión actual',
      'VERSION_CONFLICT',
      { current },
    );
  }

  private itemEvent(
    name: string,
    actor: Actor,
    item: CartItem,
    extra: Record<string, unknown> = {},
  ): void {
    this.log.info(`cart_item.${name}`, {
      cartId: item.cartId,
      itemId: item.id,
      actorId: actor.userId,
      ...extra,
    });
  }
}

function toPage<T>(from: ChangeCursor | null, batch: ChangeBatch<T>): ChangePage<T> {
  const position = batch.last ?? from;
  return {
    items: batch.items,
    nextCursor: position ? encodeCursor(position) : null,
    hasMore: batch.hasMore,
  };
}
