import { DomainError, forbiddenError } from '../shared/errors.js';
import { hasFullAccess, type Actor } from '../scope/scope.js';

export const CART_STATUSES = ['open', 'cancelled'] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const PERM_CART_USE = 'carts.use';
export const PERM_CART_READ = 'carts.read';

export interface Cart {
  readonly id: string;
  readonly establishmentId: string;
  /** Owner of the cart (a user of identity; no FK, ADR-0001). */
  readonly createdBy: string;
  readonly status: CartStatus;
  readonly cancelledBy: string | null;
  readonly cancelledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Why an active item cannot be sold now (R-8), evaluated at read time. */
export type UnavailableReason =
  'LINE_INACTIVE' | 'INVENTORY_INACTIVE' | 'PRODUCT_INACTIVE' | 'INSUFFICIENT_STOCK';

/** An active item of a cart with its product, lot and calculated subtotal (all amounts as text). */
export interface CartDetailItem {
  readonly id: string;
  readonly version: number;
  readonly product: {
    readonly id: string;
    readonly sku: string;
    readonly name: string;
    readonly unit: string;
    readonly price: string;
  };
  readonly line: {
    readonly id: string;
    readonly barcode: string;
    readonly expiresOn: string | null;
    readonly quantityCurrent: string;
  };
  readonly quantity: string;
  /** round(quantity x price, 2), half-up, calculated in SQL (ADR-0003). */
  readonly subtotal: string;
  readonly available: boolean;
  readonly unavailableReason: UnavailableReason | null;
}

export interface CartDetail {
  readonly cart: Cart;
  readonly items: CartDetailItem[];
  /** Sum of the subtotals of the available items, calculated in SQL. */
  readonly total: string;
  readonly unavailableCount: number;
}

export const cartNotFoundError = (): DomainError =>
  new DomainError('not_found', 'Carrito no encontrado', 'CART_NOT_FOUND');

/** True when the actor may read carts of other users (`carts.read` and `establishments.all`). */
export function canReadOthersCarts(actor: Actor): boolean {
  return actor.permissions.includes(PERM_CART_READ) && hasFullAccess(actor);
}

export const isOwner = (cart: Cart, actor: Actor): boolean =>
  cart.createdBy.toLowerCase() === actor.userId.toLowerCase();

/**
 * Who the actor is for a cart: `owner` (full use, needs `carts.use`) or `reader` (GET only).
 * A missing cart, or a foreign one the actor cannot read, is the 404 built by `notFound` so that
 * its existence is not revealed (R-4). The owner needs `carts.use`, except to read (`forRead`) when
 * the actor may read carts of others (`carts.read` + `establishments.all`, R-1).
 */
export function cartAccess(
  cart: Cart | null,
  actor: Actor,
  notFound: () => DomainError = cartNotFoundError,
  forRead = false,
): 'owner' | 'reader' {
  if (!cart) throw notFound();
  if (isOwner(cart, actor)) {
    if (!actor.permissions.includes(PERM_CART_USE) && !(forRead && canReadOthersCarts(actor))) {
      throw forbiddenError('No tienes permiso para realizar esta acción');
    }
    return 'owner';
  }
  if (!canReadOthersCarts(actor)) throw notFound();
  return 'reader';
}
