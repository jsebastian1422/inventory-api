import type { User, UserWithPasswordHash } from './user.js';

export interface NewUser {
  readonly email: string;
  readonly passwordHash: string;
  readonly fullName: string;
  readonly roleId: string;
}

export interface UserChanges {
  readonly email?: string;
  readonly fullName?: string;
  readonly roleId?: string;
}

/** Port: user persistence. `create`/`update` throw a conflict DomainError on duplicate email. */
export interface UserRepository {
  list(limit: number, offset: number): Promise<{ items: User[]; total: number }>;
  findById(id: string): Promise<User | null>;
  findWithPasswordHashById(id: string): Promise<UserWithPasswordHash | null>;
  findWithPasswordHashByEmail(email: string): Promise<UserWithPasswordHash | null>;
  create(data: NewUser): Promise<User>;
  update(id: string, changes: UserChanges): Promise<User>;
  setActive(id: string, isActive: boolean): Promise<void>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  touchLastLogin(id: string, at: Date): Promise<void>;
  /** Active users whose role is a system role, excluding `excludeUserId`. */
  countActiveSystemRoleUsers(excludeUserId?: string): Promise<number>;
  countByRole(roleId: string): Promise<number>;
  /**
   * Runs `work` atomically and mutually exclusive with any other call (also from other
   * processes), so check-then-write rules on administrators cannot race. `work` receives a
   * repository bound to the same transaction; if it throws, every write is rolled back.
   */
  runExclusive<T>(work: (users: UserRepository) => Promise<T>): Promise<T>;
}
