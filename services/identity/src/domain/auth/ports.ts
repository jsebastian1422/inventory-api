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

/**
 * Sliding-window attempt counter keyed by an opaque string (for example `login:email:a@b.co`).
 * The default adapter lives in process memory; a shared store can replace it behind this port.
 */
export interface AttemptLimiter {
  /** Seconds until `key` falls below `max` attempts within the window; 0 when not limited. */
  retryAfter(key: string, max: number, windowSeconds: number): number;
  /** Counts one attempt for `key`. */
  record(key: string, windowSeconds: number): void;
  /** Forgets every attempt of `key`. */
  reset(key: string): void;
}

/** Operations that run inside the same database transaction as the token redemption. */
export interface PasswordResetTransaction {
  isUserActive(userId: string): Promise<boolean>;
  setPassword(userId: string, passwordHash: string): Promise<void>;
  revokeAllRefreshTokens(userId: string): Promise<void>;
}

export interface PasswordResetTokenRepository {
  /**
   * In one transaction: marks every unused token of the user as used and stores the new one
   * (only the hash is persisted).
   */
  replaceForUser(
    userId: string,
    data: { tokenHash: string; expiresAt: Date },
    now: Date,
  ): Promise<void>;
  /**
   * Looks up an unused, unexpired token by hash and locks it. While the lock is held it marks the
   * token as used and runs `apply` with the owner and a handle bound to the same transaction.
   * Marking the token, `apply`'s writes and the commit are all-or-nothing: if `apply` throws,
   * everything is rolled back and the token stays unused.
   * Returns false when there is no usable token (nothing is run).
   */
  redeem(
    tokenHash: string,
    now: Date,
    apply: (userId: string, tx: PasswordResetTransaction) => Promise<void>,
  ): Promise<boolean>;
}

export interface PasswordResetMail {
  readonly to: string;
  readonly fullName: string;
  /** Full link to the web reset page, token included: never log it. */
  readonly link: string;
  readonly expiresInMinutes: number;
}

/** Outgoing e-mail channel. Throws when the message could not be handed to the mail server. */
export interface Mailer {
  sendPasswordReset(mail: PasswordResetMail): Promise<void>;
}
