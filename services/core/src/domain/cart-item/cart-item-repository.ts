import type { EffectiveOutcome } from '../cart/cart-repository.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { CartItem, NewCartItem } from './cart-item.js';

/**
 * Item writes run in one transaction that locks the cart FOR UPDATE and then the product,
 * inventory and line FOR SHARE (R-8 order). Existences are validated, never reserved (R-3).
 */
export interface CartItemRepository {
  findById(id: string): Promise<CartItem | null>;
  /**
   * Adds the quantity to the item of that line (reactivating it with the new quantity when it was
   * removed) or creates it. Errors, in order: 404 cart / line, 409 CART_NOT_OPEN,
   * CART_LINE_OTHER_ESTABLISHMENT, INVENTORY_LINE_INACTIVE, INVENTORY_INACTIVE, PRODUCT_INACTIVE,
   * INSUFFICIENT_STOCK (with `details`) and CART_ITEM_ID_TAKEN.
   */
  add(
    cartId: string,
    data: NewCartItem,
    now: Date,
    id?: string,
  ): Promise<{ item: CartItem; created: boolean; reactivated: boolean }>;
  /** Sets (does not add) the quantity, with the validations of `add`. */
  setQuantity(
    id: string,
    quantity: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<CartItem>>;
  /** Removing is always allowed in an open cart; reactivating applies the validations of `add`. */
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<CartItem>>;
  /** Feed of the items of the carts created by `createdBy` (ADR-0002). */
  listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    createdBy: string,
  ): Promise<ChangeBatch<CartItem>>;
}
