import type {
  AttemptLimiter,
  Mailer,
  PasswordHasher,
  PasswordResetTokenRepository,
  RefreshTokenCodec,
  RefreshTokenRepository,
} from '../../domain/auth/ports.js';
import type { AuditLog } from '../../domain/shared/audit-log.js';
import { normalizeEmail } from '../../domain/shared/email.js';
import { DomainError } from '../../domain/shared/errors.js';
import { assertPasswordPolicy } from '../../domain/user/password-policy.js';
import type { UserRepository } from '../../domain/user/user-repository.js';

export const PASSWORD_RESET_REQUESTED_MESSAGE =
  'Si el correo corresponde a una cuenta activa, enviaremos un enlace para restablecer la contraseña';
export const INVALID_RESET_TOKEN_MESSAGE = 'El enlace no es válido o ya expiró. Solicita uno nuevo';

/** Reset requests allowed per window: per e-mail and per IP. */
export const RESET_MAX_REQUESTS_EMAIL = 3;
export const RESET_MAX_REQUESTS_IP = 10;
export const RESET_WINDOW_SECONDS = 900;

export interface PasswordResetDeps {
  readonly users: UserRepository;
  readonly resetTokens: PasswordResetTokenRepository;
  readonly refreshTokens: RefreshTokenRepository;
  readonly codec: RefreshTokenCodec;
  readonly hasher: PasswordHasher;
  readonly mailer: Mailer;
  readonly limiter: AttemptLimiter;
  readonly log: AuditLog;
  /** Public URL of the web app (no trailing slash); null when not configured. */
  readonly webAppUrl: string | null;
  readonly ttlSeconds: number;
  readonly now: () => Date;
}

/**
 * Creates a one-use reset token and mails the link. It never reveals whether the account exists
 * or whether a limit was hit: the caller always answers the same. Mail is handed off without
 * waiting for the mail server, so timing does not leak either.
 */
export class RequestPasswordResetUseCase {
  private readonly deliveries = new Set<Promise<void>>();

  constructor(private readonly deps: PasswordResetDeps) {}

  async execute(input: { email: string; ip?: string }): Promise<void> {
    const { users, resetTokens, codec, limiter, log, now } = this.deps;
    const email = normalizeEmail(input.email);
    const emailKey = `reset:email:${email}`;
    const ipKey = `reset:ip:${input.ip ?? 'unknown'}`;
    const limited =
      limiter.retryAfter(emailKey, RESET_MAX_REQUESTS_EMAIL, RESET_WINDOW_SECONDS) > 0 ||
      limiter.retryAfter(ipKey, RESET_MAX_REQUESTS_IP, RESET_WINDOW_SECONDS) > 0;
    if (limited) {
      log.warn('auth.password_reset.throttled', { email: email.slice(0, 254) });
      return;
    }
    limiter.record(emailKey, RESET_WINDOW_SECONDS);
    limiter.record(ipKey, RESET_WINDOW_SECONDS);

    const found = await users.findWithPasswordHashByEmail(email);
    if (!found || !found.user.isActive) {
      log.info('auth.password_reset.ignored', { email: email.slice(0, 254) });
      return;
    }
    if (!this.deps.webAppUrl) {
      log.warn('auth.mail.failed', { userId: found.user.id, reason: 'web_app_url_not_configured' });
      return;
    }

    const issued = codec.generate();
    const current = now();
    await resetTokens.replaceForUser(
      found.user.id,
      {
        tokenHash: issued.hash,
        expiresAt: new Date(current.getTime() + this.deps.ttlSeconds * 1000),
      },
      current,
    );
    log.info('auth.password_reset.requested', { userId: found.user.id });
    this.deliver(found.user.id, {
      to: found.user.email,
      fullName: found.user.fullName,
      link: `${this.deps.webAppUrl}/restablecer#token=${issued.token}`,
      expiresInMinutes: Math.round(this.deps.ttlSeconds / 60),
    });
  }

  /** Resolves when every mail handed off so far has finished (tests and graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.deliveries]);
  }

  private deliver(userId: string, mail: Parameters<Mailer['sendPasswordReset']>[0]): void {
    const delivery = this.deps.mailer
      .sendPasswordReset(mail)
      .catch((error: unknown) => {
        // Only the error class: SMTP messages can echo addresses and the link must never be logged.
        this.deps.log.warn('auth.mail.failed', {
          userId,
          reason: error instanceof Error ? error.name : 'unknown',
        });
      })
      .finally(() => this.deliveries.delete(delivery));
    this.deliveries.add(delivery);
  }
}

/** Sets a new password from a reset token and closes every session of the user. */
export class ConfirmPasswordResetUseCase {
  constructor(private readonly deps: PasswordResetDeps) {}

  async execute(input: { token: string; newPassword: string }): Promise<void> {
    const { resetTokens, codec, hasher, log, now } = this.deps;
    assertPasswordPolicy(input.newPassword, 'newPassword');
    const invalid = (reason: string, userId?: string) => {
      log.warn('auth.password_reset.failed', { reason, ...(userId ? { userId } : {}) });
      return new DomainError('validation', INVALID_RESET_TOKEN_MESSAGE, 'INVALID_RESET_TOKEN');
    };

    let completedFor: string | null = null;
    const redeemed = await resetTokens.redeem(
      codec.hash(input.token),
      now(),
      async (userId, tx) => {
        if (!(await tx.isUserActive(userId))) throw invalid('inactive_user', userId);
        await tx.setPassword(userId, await hasher.hash(input.newPassword));
        await tx.revokeAllRefreshTokens(userId);
        completedFor = userId;
      },
    );
    if (!redeemed) throw invalid('unusable_token');
    log.info('auth.password_reset.completed', { userId: completedFor });
  }
}
