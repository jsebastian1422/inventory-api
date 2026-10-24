/** Permission code: `<module>.<action>`, for example `users.read`. */
export type PermissionCode = string;

/** Permissions defined by the identity service. Future modules add their own by migration. */
export const IDENTITY_PERMISSIONS = [
  'users.read',
  'users.create',
  'users.update',
  'users.deactivate',
  'roles.read',
  'roles.create',
  'roles.update',
  'roles.delete',
] as const;

export type IdentityPermission = (typeof IDENTITY_PERMISSIONS)[number];

/** True when `granted` contains every permission in `required`. */
export function hasAllPermissions(
  granted: readonly PermissionCode[],
  required: readonly PermissionCode[],
): boolean {
  const set = new Set(granted);
  return required.every((code) => set.has(code));
}
