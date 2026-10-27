import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { Cart, CartDetail, CartStatus } from './cart.js';

export interface CartFilter {
  /** Owner whose carts are listed. */
  readonly createdBy: string;
  readonly status?: CartStatus;
  readonly establishmentId?: string;
  readonly limit: number;
  readonly offset: number;
}

/** Outcome of a conditional write; `changed` is false when the record was already in that state. */
export type EffectiveOutcome<T> =
  | { readonly status: 'updated'; readonly value: T; readonly changed: boolean }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict'; readonly current: T };

export interface CartRepository {
  /**
   * Locks the establishment FOR SHARE (404 / 409 ESTABLISHMENT_INACTIVE) and inserts an open cart.
   * Throws 409 CART_ID_TAKEN when the id is used (race-safe).
   */
  create(establishmentId: string, actorId: string, id?: string): Promise<Cart>;
  findById(id: string): Promise<Cart | null>;
  /** Header, active items with product, lot, subtotal and availability, and the total (SQL). */
  findDetail(id: string): Promise<CartDetail | null>;
  /** Most recent first. */
  list(filter: CartFilter): Promise<{ items: Cart[]; total: number }>;
  /** Locks the cart; only from `open` (an already cancelled cart is answered unchanged). */
  cancel(
    id: string,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<EffectiveOutcome<Cart>>;
  /** Feed of the carts created by `createdBy` (ADR-0002). */
  listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    createdBy: string,
  ): Promise<ChangeBatch<Cart>>;
}
