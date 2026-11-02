import type { Cart } from '../cart/cart.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { Customer, Sale } from './sale.js';

export interface CheckoutInput {
  readonly cartId: string;
  /** The seller: the owner of the cart. */
  readonly actorId: string;
  readonly expectedVersion?: number;
  /** Optional client-generated id of the sale (offline creation). */
  readonly saleId?: string;
  readonly customer: Customer | null;
  readonly now: Date;
}

export type CheckoutOutcome =
  | { readonly status: 'sold'; readonly sale: Sale }
  | { readonly status: 'conflict'; readonly current: Cart };

/** Which sales a listing may show: the seller's own and/or those of establishments (R-1). */
export interface SaleVisibility {
  readonly sellerId?: string;
  /** `'all'` = every establishment (`sales.read` + `establishments.all`). */
  readonly establishmentIds?: readonly string[] | 'all';
}

export interface SaleFilter {
  readonly visibility: SaleVisibility;
  readonly establishmentId?: string;
  readonly sellerId?: string;
  /** Dates (YYYY-MM-DD), both inclusive, read as UTC days. */
  readonly from?: string;
  readonly to?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface SaleRepository {
  /**
   * One transaction (spec 3.1): locks the cart, establishment, products, inventories and lines
   * (that order), validates every active item, numbers the sale with the locked counter of the
   * establishment (ADR-0005), inserts the sale and its frozen items, discounts each lot with its
   * `sale` history row and marks the cart `sold`. Errors, in order: 404 CART_NOT_FOUND,
   * 409 ESTABLISHMENT_INACTIVE, CART_NOT_OPEN, CART_EMPTY, SALE_ITEMS_UNAVAILABLE (with `details`),
   * SALE_AMOUNT_OUT_OF_RANGE, SALE_ID_TAKEN. A stale `expectedVersion` answers `conflict`.
   */
  checkout(input: CheckoutInput): Promise<CheckoutOutcome>;
  /** Sale with its items. */
  findById(id: string): Promise<Sale | null>;
  /** Most recent first, items included. */
  list(filter: SaleFilter): Promise<{ items: Sale[]; total: number }>;
  /** Feed of the sales made by `sellerId` (ADR-0002), items included. */
  listChanges(
    cursor: ChangeCursor | null,
    limit: number,
    sellerId: string,
  ): Promise<ChangeBatch<Sale>>;
}
