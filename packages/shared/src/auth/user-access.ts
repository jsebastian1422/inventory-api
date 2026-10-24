import { hasAllPermissions, type PermissionCode } from './permissions.js';

/**
 * Live access data of a user. Read-only query shared by every service (ADR-0001):
 * user status and the permissions of their role. The system role holds every permission.
 * Parameter: $1 = user id.
 */
export const USER_ACCESS_QUERY = `SELECT u.id, u.role_id, u.is_active,
              ARRAY(
                SELECT p.code::text FROM permissions p
                WHERE r.is_system OR EXISTS (
                  SELECT 1 FROM role_permissions rp WHERE rp.role_id = r.id AND rp.permission_id = p.id
                )
                ORDER BY p.code
              ) AS permissions
       FROM users u JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`;

/** Row returned by USER_ACCESS_QUERY. */
export interface UserAccessRow {
  readonly id: string;
  readonly role_id: string;
  readonly is_active: boolean;
  readonly permissions: string[];
}

export interface UserAccess {
  readonly userId: string;
  readonly roleId: string;
  readonly isActive: boolean;
  readonly permissions: string[];
}

/** Maps a USER_ACCESS_QUERY row to UserAccess. */
export function toUserAccess(row: UserAccessRow): UserAccess {
  return {
    userId: row.id,
    roleId: row.role_id,
    isActive: row.is_active,
    permissions: row.permissions,
  };
}

/** Raised by assertAccess: `unauthorized` maps to HTTP 401, `forbidden` to HTTP 403. */
export class AccessDeniedError extends Error {
  constructor(readonly kind: 'unauthorized' | 'forbidden') {
    super(kind === 'unauthorized' ? 'User not found or inactive' : 'Missing permission');
    this.name = 'AccessDeniedError';
  }
}

/**
 * Pure decision: the user must exist and be active (else `unauthorized`) and hold every required
 * permission (else `forbidden`). Returns the access when granted.
 */
export function assertAccess(
  access: UserAccess | null,
  required: readonly PermissionCode[],
): UserAccess {
  if (!access || !access.isActive) throw new AccessDeniedError('unauthorized');
  if (!hasAllPermissions(access.permissions, required)) throw new AccessDeniedError('forbidden');
  return access;
}
