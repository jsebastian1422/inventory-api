import { forbiddenError } from './errors.js';

export const PRIVILEGE_ESCALATION_CODE = 'PRIVILEGE_ESCALATION';

/** The authenticated user performing an action, with the permissions effective right now. */
export interface Actor {
  readonly id: string;
  readonly roleId: string;
  readonly permissions: readonly string[];
}

/** Permissions in `wanted` that are not in `held` (sorted, without duplicates). */
export function missingPermissions(held: readonly string[], wanted: readonly string[]): string[] {
  const owned = new Set(held);
  return [...new Set(wanted)].filter((code) => !owned.has(code)).sort();
}

/** True when every permission of `subset` is also in `superset`. */
export function isSubset(subset: readonly string[], superset: readonly string[]): boolean {
  return missingPermissions(superset, subset).length === 0;
}

/**
 * Anti-escalation rule "do not grant what you do not have": the actor may only grant, or touch
 * something that grants, permissions it holds itself.
 */
export function assertCanGrant(actor: Actor, permissions: readonly string[], what: string): void {
  if (!isSubset(permissions, actor.permissions)) {
    throw forbiddenError(
      `No puedes ${what} porque implica permisos que tú no tienes`,
      PRIVILEGE_ESCALATION_CODE,
    );
  }
}

/** Nobody can modify (data, permissions, deletion) the role they hold themselves. */
export function assertNotOwnRole(actor: Actor, roleId: string): void {
  if (actor.roleId === roleId) {
    throw forbiddenError('No puedes modificar tu propio rol', PRIVILEGE_ESCALATION_CODE);
  }
}
