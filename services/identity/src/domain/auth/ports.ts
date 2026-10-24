export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  /** With a null hash (unknown user) it spends the same time and returns false. */
  verify(hash: string | null, plain: string): Promise<boolean>;
}

export interface IssuedAccessToken {
  readonly token: string;
  /** Lifetime in seconds. */
  readonly expiresIn: number;
}

export interface AccessTokenIssuer {
  issue(userId: string): Promise<IssuedAccessToken>;
}

/** Opaque refresh tokens: random value for the client, only its hash is stored. */
export interface RefreshTokenCodec {
  generate(): { token: string; hash: string };
  hash(token: string): string;
}

export interface RefreshTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface RefreshTokenRepository {
  create(data: { userId: string; tokenHash: string; expiresAt: Date }): Promise<RefreshTokenRecord>;
  findByHash(hash: string): Promise<RefreshTokenRecord | null>;
  /**
   * Atomically revokes `oldId` (only if still active) and stores the new token linked to it.
   * Returns null when `oldId` was already revoked (concurrent reuse).
   */
  rotate(
    oldId: string,
    data: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<RefreshTokenRecord | null>;
  revoke(id: string): Promise<void>;
  revokeAllForUser(userId: string): Promise<void>;
}

/** Live access data of a user, read from the database on every protected request. */
export interface UserAccess {
  readonly userId: string;
  readonly roleId: string;
  readonly isActive: boolean;
  readonly permissions: string[];
}

export interface AccessReader {
  load(userId: string): Promise<UserAccess | null>;
}
