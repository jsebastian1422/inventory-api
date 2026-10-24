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
  /** Throws a 409 ESTABLISHMENT_NAME_TAKEN when the name is already used (race-safe). */
  create(data: EstablishmentData): Promise<Establishment>;
  findById(id: string): Promise<Establishment | null>;
  /** Ordered by name with ICU linguistic collation (case-insensitive), ties broken by id; `total` ignores limit/offset. */
  list(filter: EstablishmentFilter): Promise<{ items: Establishment[]; total: number }>;
  /** Returns null when the id does not exist. Sets `updatedAt` to `now`. */
  update(id: string, changes: Partial<EstablishmentData>, now: Date): Promise<Establishment | null>;
  setActive(id: string, isActive: boolean, now: Date): Promise<Establishment | null>;
  /** Case-insensitive name check, optionally ignoring one establishment (edit). */
  existsByName(name: string, excludeId?: string): Promise<boolean>;
}
