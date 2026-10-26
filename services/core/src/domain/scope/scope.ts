import { conflictError, forbiddenError, notFoundError } from '../shared/errors.js';

/** Who is asking: id and the live permissions loaded by the guard. */
export interface Actor {
  readonly userId: string;
  readonly permissions: readonly string[];
}

/**
 * Establishments a user can operate in (ADR-0004), always the ACTIVE ones: every active
 * establishment (`all`, permission `establishments.all`) or the actively assigned ones (`assigned`).
 */
export interface EstablishmentScope {
  readonly access: 'all' | 'assigned';
  readonly ids: readonly string[];
}

export const PERM_ALL = 'establishments.all';

/** True when the actor holds `establishments.all`. */
export const hasFullAccess = (actor: Actor): boolean => actor.permissions.includes(PERM_ALL);

/**
 * R-5: missing establishment -> 404; inactive -> 409; outside the scope -> 403.
 * `establishment` is what the repository found for the requested id.
 */
export function assertInScope(
  establishment: { readonly id: string; readonly isActive: boolean } | null,
  scope: EstablishmentScope,
): void {
  if (!establishment) throw notFoundError('Establecimiento no encontrado');
  if (!establishment.isActive) {
    throw conflictError('El establecimiento está inactivo', 'ESTABLISHMENT_INACTIVE');
  }
  if (!scope.ids.includes(establishment.id)) {
    throw forbiddenError('No tienes acceso a este establecimiento', 'ESTABLISHMENT_NOT_IN_SCOPE');
  }
}

/** Record of a scoped feed: complete when in scope, only its id otherwise (ADR-0004). */
export type ScopedRecord<T> =
  { readonly inScope: true; readonly value: T } | { readonly inScope: false; readonly id: string };
