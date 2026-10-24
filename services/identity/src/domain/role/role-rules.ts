import { conflictError, validationError } from '../shared/errors.js';
import type { Role } from './role.js';

export const ROLE_NAME_MAX = 100;
export const ROLE_DESCRIPTION_MAX = 500;

export function normalizeRoleName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > ROLE_NAME_MAX) {
    throw validationError('Datos inválidos', [
      {
        field: 'name',
        message: `El nombre es obligatorio y no puede superar ${ROLE_NAME_MAX} caracteres`,
      },
    ]);
  }
  return name;
}

export function assertCanDeleteRole(role: Role, assignedUsers: number): void {
  if (role.isSystem) {
    throw conflictError(
      'El rol de sistema Administrador no se puede eliminar',
      'SYSTEM_ROLE_PROTECTED',
    );
  }
  if (assignedUsers > 0) {
    throw conflictError('No se puede eliminar un rol con usuarios asignados', 'ROLE_IN_USE');
  }
}

export function assertCanChangePermissions(role: Role): void {
  if (role.isSystem) {
    throw conflictError(
      'No se pueden modificar los permisos del rol de sistema Administrador',
      'SYSTEM_ROLE_PROTECTED',
    );
  }
}

export function assertCanRename(role: Role, newName: string): void {
  if (role.isSystem && newName.toLowerCase() !== role.name.toLowerCase()) {
    throw conflictError(
      'El rol de sistema Administrador no se puede renombrar',
      'SYSTEM_ROLE_PROTECTED',
    );
  }
}
