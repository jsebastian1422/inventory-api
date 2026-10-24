import type { Role } from './role.js';

/** Port: role persistence. `create`/`update` throw a conflict DomainError on duplicate name. */
export interface RoleRepository {
  list(): Promise<Role[]>;
  findById(id: string): Promise<Role | null>;
  findSystemRole(): Promise<Role | null>;
  create(data: { name: string; description: string }): Promise<Role>;
  update(id: string, changes: { name?: string; description?: string }): Promise<Role>;
  delete(id: string): Promise<void>;
  /** Replaces the permission set (codes must already be validated against the catalog). */
  setPermissions(id: string, codes: readonly string[]): Promise<Role>;
}
