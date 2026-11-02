import { cartNotFoundError, isOwner, type Cart } from '../../domain/cart/cart.js';
import type { CartRepository } from '../../domain/cart/cart-repository.js';
import {
  canReadSales,
  canSell,
  isSeller,
  normalizeCustomer,
  readsAllSales,
  saleNotFoundError,
  type CustomerInput,
  type Sale,
} from '../../domain/sale/sale.js';
import type { SaleRepository, SaleVisibility } from '../../domain/sale/sale-repository.js';
import { hasFullAccess, type Actor } from '../../domain/scope/scope.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { conflictError, forbiddenError, validationError } from '../../domain/shared/errors.js';
import { decodeCursor, encodeCursor, type ChangePage } from '../../domain/sync/change-cursor.js';
import type { ScopeUseCases } from '../scope/scope.use-cases.js';

export interface SaleListQuery {
  readonly establishmentId?: string;
  /** Only for who holds `sales.read` (or the actor's own id). */
  readonly sellerId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly offset: number;
}

const DENIED = 'No tienes permiso para realizar esta acción';

/**
 * Sales (sprint 008). Selling needs the owner of the cart, `sales.create` and the establishment in
 * the live scope (ADR-0004). A sale is read by its seller (`sales.create`) or by who holds
 * `sales.read` for an establishment in scope (with `establishments.all`, any); otherwise it does
 * not exist (404). Audit events carry ids and amounts, never buyer data.
 */
export class SaleUseCases {
  constructor(
    private readonly sales: SaleRepository,
    private readonly carts: CartRepository,
    private readonly scope: ScopeUseCases,
    private readonly log: AuditLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Converts the cart into a sale. Order: 400 (buyer) -> 403 (`sales.create`) -> 404 (cart not
   * the actor's) -> 404/409/403 (establishment) -> VERSION_CONFLICT -> 409 state, empty, items.
   */
  async checkout(
    actor: Actor,
    cartId: string,
    input: { id?: string; customer?: CustomerInput | null },
    expectedVersion?: number,
  ): Promise<Sale> {
    const customer = normalizeCustomer(input.customer);
    const cart = await this.sellableCart(actor, cartId);
    if (expectedVersion !== undefined && cart.version !== expectedVersion) {
      throw this.versionConflict(actor, cart, expectedVersion);
    }
    const outcome = await this.sales.checkout({
      cartId,
      actorId: actor.userId,
      expectedVersion,
      saleId: input.id,
      customer,
      now: this.now(),
    });
    if (outcome.status === 'conflict') {
      throw this.versionConflict(actor, outcome.current, expectedVersion);
    }
    this.logSale(actor, outcome.sale);
    return outcome.sale;
  }

  /**
   * Authorization of a replayed `POST /carts/:id/checkout`: the same checks as a new sale
   * (permission, owner, scope), without looking at the state of the cart.
   */
  async authorizeCheckout(actor: Actor, cartId: string): Promise<void> {
    await this.sellableCart(actor, cartId);
  }

  async get(actor: Actor, id: string): Promise<Sale> {
    const sale = await this.sales.findById(id);
    if (!sale || !(await this.canSee(actor, sale))) throw saleNotFoundError();
    return sale;
  }

  /** Own sales (`sales.create`) and those of the scope (`sales.read`); 403 with neither. */
  async list(actor: Actor, query: SaleListQuery): Promise<{ items: Sale[]; total: number }> {
    if (!canSell(actor) && !canReadSales(actor)) throw forbiddenError(DENIED);
    if (
      query.sellerId !== undefined &&
      !canReadSales(actor) &&
      query.sellerId.toLowerCase() !== actor.userId.toLowerCase()
    ) {
      throw forbiddenError(DENIED);
    }
    if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
      throw validationError('Datos inválidos', [
        { field: 'from', message: 'La fecha inicial no puede ser posterior a la final' },
      ]);
    }
    return this.sales.list({
      visibility: await this.visibility(actor),
      establishmentId: query.establishmentId,
      sellerId: query.sellerId,
      from: query.from,
      to: query.to,
      limit: query.limit,
      offset: query.offset,
    });
  }

  /** Feed of the sales made by the actor (ADR-0002); 400 when the cursor is malformed. */
  async changes(
    actor: Actor,
    cursor: string | undefined,
    limit: number,
  ): Promise<ChangePage<Sale>> {
    if (!canSell(actor)) throw forbiddenError(DENIED);
    const from = cursor === undefined ? null : decodeCursor(cursor);
    const batch = await this.sales.listChanges(from, limit, actor.userId);
    const position = batch.last ?? from;
    return {
      items: batch.items,
      nextCursor: position ? encodeCursor(position) : null,
      hasMore: batch.hasMore,
    };
  }

  /** 403 without `sales.create`; 404 when the cart is not the actor's; then the live scope. */
  private async sellableCart(actor: Actor, cartId: string) {
    if (!canSell(actor)) throw forbiddenError(DENIED);
    const cart = await this.carts.findById(cartId);
    if (!cart || !isOwner(cart, actor)) throw cartNotFoundError();
    await this.scope.assertInScope(actor, cart.establishmentId);
    return cart;
  }

  /** What the actor may list: own sales and/or those of the establishments in scope (R-1). */
  private async visibility(actor: Actor): Promise<SaleVisibility> {
    const own = canSell(actor) ? actor.userId : undefined;
    if (!canReadSales(actor)) return { sellerId: own };
    if (hasFullAccess(actor)) return { sellerId: own, establishmentIds: 'all' };
    const ids = await this.scope.resolveForSalesRead(actor);
    return { sellerId: own, establishmentIds: ids };
  }

  private async canSee(actor: Actor, sale: Sale): Promise<boolean> {
    if (canSell(actor) && isSeller(sale, actor)) return true;
    if (!canReadSales(actor)) return false;
    if (readsAllSales(actor)) return true;
    const ids = await this.scope.resolveForSalesRead(actor);
    return ids.includes(sale.establishmentId);
  }

  private versionConflict(actor: Actor, current: Cart, expected?: number) {
    this.log.warn('cart.version_conflict', {
      cartId: current.id,
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

  private logSale(actor: Actor, sale: Sale): void {
    this.log.info('sale.created', {
      saleId: sale.id,
      number: sale.number,
      establishmentId: sale.establishmentId,
      sellerId: sale.sellerId,
      cartId: sale.cartId,
      total: sale.total,
      actorId: actor.userId,
    });
    for (const item of sale.items) {
      this.log.info('inventory_line.quantity_sold', {
        saleId: sale.id,
        inventoryLineId: item.inventoryLineId,
        quantity: item.quantity,
        actorId: actor.userId,
      });
    }
  }
}
