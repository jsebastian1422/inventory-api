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

/** Permissions of the establishments module (services/core). Added to the catalog by migration. */
export const ESTABLISHMENT_PERMISSIONS = [
  'establishments.read',
  'establishments.create',
  'establishments.update',
  'establishments.deactivate',
] as const;

export type EstablishmentPermission = (typeof ESTABLISHMENT_PERMISSIONS)[number];

/** Permissions of the categories module (services/core). Added to the catalog by migration. */
export const CATEGORY_PERMISSIONS = [
  'categories.read',
  'categories.create',
  'categories.update',
  'categories.deactivate',
] as const;

export type CategoryPermission = (typeof CATEGORY_PERMISSIONS)[number];

/** Permissions of the products module (services/core). Added to the catalog by migration. */
export const PRODUCT_PERMISSIONS = [
  'products.read',
  'products.create',
  'products.update',
  'products.deactivate',
] as const;

export type ProductPermission = (typeof PRODUCT_PERMISSIONS)[number];

/** Permissions of the inventories module; inventory lines are managed with these too. */
export const INVENTORY_PERMISSIONS = [
  'inventories.read',
  'inventories.create',
  'inventories.update',
  'inventories.deactivate',
] as const;

export type InventoryPermission = (typeof INVENTORY_PERMISSIONS)[number];
