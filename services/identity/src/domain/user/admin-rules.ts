import { conflictError } from '../shared/errors.js';
import type { User } from './user.js';

export const LAST_ADMIN_CODE = 'LAST_ADMIN';

/**
 * A user holding the system role (Administrador) that is the only active one cannot lose that
 * status (deactivation or role change).
 */
export function assertNotLastActiveAdmin(
  target: User,
  otherActiveAdmins: number,
  action: 'desactivar al' | 'cambiar el rol del',
): void {
  if (target.isActive && target.role.isSystem && otherActiveAdmins === 0) {
    throw conflictError(`No se puede ${action} el último administrador activo`, LAST_ADMIN_CODE);
  }
}

export const USE_CHANGE_PASSWORD_CODE = 'USE_CHANGE_PASSWORD';

/** Resetting one's own password would skip the current-password check; use change-password. */
export function assertNotSelfPasswordReset(actorId: string, targetId: string): void {
  if (actorId.toLowerCase() === targetId.toLowerCase()) {
    throw conflictError(
      'No puedes restablecer tu propia contraseña; usa /auth/change-password',
      USE_CHANGE_PASSWORD_CODE,
    );
  }
}
