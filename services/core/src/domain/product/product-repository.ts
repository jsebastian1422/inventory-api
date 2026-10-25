import type { StatusFilter } from '../establishment/establishment-repository.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { WriteOutcome } from '../sync/version.js';
import type { PriceChange, Product, ProductData } from './product.js';

export interface ProductFilter {
  readonly status: StatusFilter;
  /** Free text matched against SKU or name (case-insensitive, literal). */
  readonly q?: string;
  readonly categoryId?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface ProductRepository {
  /**
   * One transaction: locks the category (404 / 409 CATEGORY_INACTIVE), inserts the product and its
   * initial price history row. Throws 409 PRODUCT_SKU_TAKEN / PRODUCT_ID_TAKEN (race-safe).
   */
  create(data: ProductData, actorId: string, id?: string): Promise<Product>;
  findById(id: string): Promise<Product | null>;
  /** Ordered by name (ICU collation), ties broken by id. */
  list(filter: ProductFilter): Promise<{ items: Product[]; total: number }>;
  /**
   * One transaction with conditional update by version. A new category must exist and be active;
   * a real price change adds a price history row.
   */
  update(
    id: string,
    changes: Partial<ProductData>,
    actorId: string,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Product>>;
  /**
   * Activation requires an active category (409 CATEGORY_INACTIVE). Deactivation throws a 409
   * PRODUCT_IN_ACTIVE_INVENTORY when an active line of an active inventory uses it (R-8).
   */
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Product>>;
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Product>>;
  /** Most recent first. */
  listPriceHistory(
    productId: string,
    limit: number,
    offset: number,
  ): Promise<{ items: PriceChange[]; total: number }>;
}
