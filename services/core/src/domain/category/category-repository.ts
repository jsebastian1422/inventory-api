import type { StatusFilter } from '../establishment/establishment-repository.js';
import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { WriteOutcome } from '../sync/version.js';
import type { Category, CategoryData } from './category.js';

export interface CategoryFilter {
  readonly status: StatusFilter;
  /** Free text matched against code or name (case-insensitive, literal). */
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface CategoryRepository {
  /**
   * `id` is optional (client-generated). Throws a 409 CATEGORY_CODE_TAKEN, CATEGORY_NAME_TAKEN or
   * CATEGORY_ID_TAKEN (race-safe).
   */
  create(data: CategoryData, id?: string): Promise<Category>;
  findById(id: string): Promise<Category | null>;
  /** Ordered by code, ties broken by id; `total` ignores limit/offset. */
  list(filter: CategoryFilter): Promise<{ items: Category[]; total: number }>;
  /** Atomic conditional update (see EstablishmentRepository.update). */
  update(
    id: string,
    changes: Partial<CategoryData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Category>>;
  /**
   * Deactivation locks the category and throws a 409 CATEGORY_HAS_ACTIVE_PRODUCTS when it still has
   * active products (R-8), after the version check.
   */
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Category>>;
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Category>>;
  /** Case-insensitive checks, optionally ignoring one category (edit). */
  existsByCode(code: string, excludeId?: string): Promise<boolean>;
  existsByName(name: string, excludeId?: string): Promise<boolean>;
}
