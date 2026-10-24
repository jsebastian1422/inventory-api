import type { UserAccess } from '@inventory/shared';

/** Reads the live access of a user (status and role permissions). Read-only, see ADR-0001. */
export interface AccessReader {
  load(userId: string): Promise<UserAccess | null>;
}
