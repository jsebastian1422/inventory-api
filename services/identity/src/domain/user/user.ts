export const FULL_NAME_MAX = 150;

export interface RoleSummary {
  readonly id: string;
  readonly name: string;
  readonly isSystem: boolean;
}

/** User as exposed by the system. It never carries the password hash. */
export interface User {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly role: RoleSummary;
  readonly isActive: boolean;
  readonly lastLoginAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UserWithPasswordHash {
  readonly user: User;
  readonly passwordHash: string;
}
