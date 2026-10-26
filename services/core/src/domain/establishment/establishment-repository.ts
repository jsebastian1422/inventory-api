import type { ChangeBatch, ChangeCursor } from '../sync/change-cursor.js';
import type { WriteOutcome } from '../sync/version.js';
import type { Establishment, EstablishmentData } from './establishment.js';

export type StatusFilter = 'active' | 'inactive' | 'all';

export interface EstablishmentFilter {
  readonly status: StatusFilter;
  /** Free text matched against name or city (case-insensitive, literal). */
  readonly q?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface EstablishmentRepository {
  /**
   * `id` is optional (client-generated). Throws a 409 ESTABLISHMENT_NAME_TAKEN or
   * ESTABLISHMENT_ID_TAKEN when the name or id is already used (race-safe).
   */
  create(data: EstablishmentData, id?: string): Promise<Establishment>;
  findById(id: string): Promise<Establishment | null>;
  /** The establishments with those ids (any status), ordered like `list`. Unknown ids are ignored. */
  findByIds(ids: readonly string[]): Promise<Establishment[]>;
  /** Ordered by name with ICU linguistic collation (case-insensitive), ties broken by id; `total` ignores limit/offset. */
  list(filter: EstablishmentFilter): Promise<{ items: Establishment[]; total: number }>;
  /**
   * Atomic conditional update: applies only if `expectedVersion` is undefined or equals the current
   * version. Sets `updatedAt` to `now`, increments the version and marks the change position.
   */
  update(
    id: string,
    changes: Partial<EstablishmentData>,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>>;
  setActive(
    id: string,
    isActive: boolean,
    now: Date,
    expectedVersion?: number,
  ): Promise<WriteOutcome<Establishment>>;
  /**
   * Changes after `cursor` (all if null) ordered by (change position, id), up to `limit`. Only
   * transactions that can no longer commit behind the cursor are included.
   */
  listChanges(cursor: ChangeCursor | null, limit: number): Promise<ChangeBatch<Establishment>>;
  /** Case-insensitive name check, optionally ignoring one establishment (edit). */
  existsByName(name: string, excludeId?: string): Promise<boolean>;
}
