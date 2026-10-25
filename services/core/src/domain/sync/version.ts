/** Largest value of a PostgreSQL `integer` (the version column). */
export const MAX_VERSION = 2_147_483_647;

/** Outcome of a conditional write on a versioned record. `current` is the server copy on conflict. */
export type WriteOutcome<T> =
  | { readonly status: 'updated'; readonly value: T }
  | { readonly status: 'not_found' }
  | { readonly status: 'conflict'; readonly current: T };

/** True when `value` is a valid record version (integer >= 1). */
export function isValidVersion(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_VERSION;
}
