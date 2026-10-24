import type {
  AccessReader,
  AccessTokenIssuer,
  PasswordHasher,
  RefreshTokenCodec,
  RefreshTokenRepository,
  UserAccess,
} from '../../domain/auth/ports.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import {
  forbiddenError,
  notFoundError,
  unauthorizedError,
  validationError,
} from '../../domain/shared/errors.js';
import type { User } from '../../domain/user/user.js';
import type { UserRepository } from '../../domain/user/user-repository.js';
import { assertPasswordPolicy } from '../../domain/user/password-policy.js';
import { hasAllPermissions } from '@inventory/shared';

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenType: 'Bearer';
  readonly expiresIn: number;
}

export const INVALID_CREDENTIALS_MESSAGE = 'Credenciales inválidas';
export const INVALID_SESSION_MESSAGE = 'Sesión inválida o expirada';

interface TokenDeps {
  readonly issuer: AccessTokenIssuer;
  readonly codec: RefreshTokenCodec;
  readonly refreshTokens: RefreshTokenRepository;
  readonly refreshTtlSeconds: number;
  readonly now: () => Date;
}

async function issuePair(deps: TokenDeps, userId: string): Promise<TokenPair> {
  const refresh = deps.codec.generate();
  const expiresAt = new Date(deps.now().getTime() + deps.refreshTtlSeconds * 1000);
  await deps.refreshTokens.create({ userId, tokenHash: refresh.hash, expiresAt });
  const access = await deps.issuer.issue(userId);
  return {
    accessToken: access.token,
    refreshToken: refresh.token,
    tokenType: 'Bearer',
    expiresIn: access.expiresIn,
  };
}

export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokens: TokenDeps,
    private readonly log: AuditLog,
  ) {}

  async execute(input: { email: string; password: string }): Promise<TokenPair> {
    const email = input.email.trim().toLowerCase();
    const found = await this.users.findWithPasswordHashByEmail(email);
    const passwordOk = await this.hasher.verify(found?.passwordHash ?? null, input.password);
    if (!found || !passwordOk || !found.user.isActive) {
      const reason = !found ? 'unknown_user' : !passwordOk ? 'bad_password' : 'inactive_user';
      this.log.warn('auth.login.failed', { email: email.slice(0, 254), reason });
      throw unauthorizedError(INVALID_CREDENTIALS_MESSAGE, 'INVALID_CREDENTIALS');
    }
    await this.users.touchLastLogin(found.user.id, this.tokens.now());
    const pair = await issuePair(this.tokens, found.user.id);
    this.log.info('auth.login.success', { userId: found.user.id, email: found.user.email });
    return pair;
  }
}

export class RefreshSessionUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly tokens: TokenDeps,
    private readonly log: AuditLog,
  ) {}

  async execute(refreshToken: string): Promise<TokenPair> {
    const invalid = () => unauthorizedError(INVALID_SESSION_MESSAGE, 'INVALID_SESSION');
    const record = await this.tokens.refreshTokens.findByHash(this.tokens.codec.hash(refreshToken));
    if (!record) throw invalid();

    if (record.revokedAt) {
      // A rotated or revoked token was presented again: assume leakage, close every session.
      await this.tokens.refreshTokens.revokeAllForUser(record.userId);
      this.log.warn('auth.refresh.reuse_detected', { userId: record.userId });
      throw invalid();
    }
    if (record.expiresAt.getTime() <= this.tokens.now().getTime()) throw invalid();

    const user = await this.users.findById(record.userId);
    if (!user || !user.isActive) {
      await this.tokens.refreshTokens.revoke(record.id);
      this.log.warn('auth.refresh.rejected', { userId: record.userId, reason: 'inactive_user' });
      throw invalid();
    }

    const next = this.tokens.codec.generate();
    const expiresAt = new Date(this.tokens.now().getTime() + this.tokens.refreshTtlSeconds * 1000);
    const stored = await this.tokens.refreshTokens.rotate(record.id, {
      userId: user.id,
      tokenHash: next.hash,
      expiresAt,
    });
    if (!stored) {
      await this.tokens.refreshTokens.revokeAllForUser(user.id);
      this.log.warn('auth.refresh.reuse_detected', { userId: user.id });
      throw invalid();
    }
    const access = await this.tokens.issuer.issue(user.id);
    this.log.info('auth.refresh.success', { userId: user.id });
    return {
      accessToken: access.token,
      refreshToken: next.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
    };
  }
}

export class LogoutUseCase {
  constructor(
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly codec: RefreshTokenCodec,
    private readonly log: AuditLog,
  ) {}

  /** Idempotent: an unknown token is ignored so the endpoint reveals nothing. */
  async execute(refreshToken: string): Promise<void> {
    const record = await this.refreshTokens.findByHash(this.codec.hash(refreshToken));
    if (record && !record.revokedAt) {
      await this.refreshTokens.revoke(record.id);
      this.log.info('auth.logout', { userId: record.userId });
    }
  }
}

export class GetCurrentUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly access: AccessReader,
  ) {}

  async execute(userId: string): Promise<{ user: User; permissions: string[] }> {
    const [user, access] = await Promise.all([
      this.users.findById(userId),
      this.access.load(userId),
    ]);
    if (!user || !access) throw unauthorizedError(INVALID_SESSION_MESSAGE, 'INVALID_SESSION');
    return { user, permissions: access.permissions };
  }
}

export class ChangeOwnPasswordUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: PasswordHasher,
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly log: AuditLog,
  ) {}

  async execute(
    userId: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const found = await this.users.findWithPasswordHashById(userId);
    if (!found) throw notFoundError('Usuario no encontrado');
    if (!(await this.hasher.verify(found.passwordHash, input.currentPassword))) {
      throw validationError('Datos inválidos', [
        { field: 'currentPassword', message: 'La contraseña actual es incorrecta' },
      ]);
    }
    assertPasswordPolicy(input.newPassword, 'newPassword');
    await this.users.updatePassword(userId, await this.hasher.hash(input.newPassword));
    await this.refreshTokens.revokeAllForUser(userId);
    this.log.info('auth.password.changed', { userId });
  }
}

/** Guard logic: the user must still be active and hold every required permission. */
export class AuthorizeRequestUseCase {
  constructor(private readonly access: AccessReader) {}

  async execute(userId: string, required: readonly string[]): Promise<UserAccess> {
    const access = await this.access.load(userId);
    if (!access || !access.isActive) {
      throw unauthorizedError(INVALID_SESSION_MESSAGE, 'INVALID_SESSION');
    }
    if (!hasAllPermissions(access.permissions, required)) {
      throw forbiddenError('No tienes permiso para realizar esta acción');
    }
    return access;
  }
}
