import type { Pool } from 'pg';
import type {
  PasswordResetTokenRepository,
  PasswordResetTransaction,
} from '../../domain/auth/ports.js';

export class PostgresPasswordResetTokenRepository implements PasswordResetTokenRepository {
  constructor(private readonly pool: Pool) {}

  async replaceForUser(
    userId: string,
    data: { tokenHash: string; expiresAt: Date },
    now: Date,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE password_reset_tokens SET used_at = $2 WHERE user_id = $1 AND used_at IS NULL',
        [userId, now],
      );
      await client.query(
        'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
        [userId, data.tokenHash, data.expiresAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async redeem(
    tokenHash: string,
    now: Date,
    apply: (userId: string, tx: PasswordResetTransaction) => Promise<void>,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // FOR UPDATE serialises concurrent confirmations: the loser re-evaluates the WHERE after the
      // winner commits and no longer finds the token.
      const { rows } = await client.query<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
         FOR UPDATE`,
        [tokenHash, now],
      );
      const row = rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('UPDATE password_reset_tokens SET used_at = $2 WHERE id = $1', [
        row.id,
        now,
      ]);
      // Password change and session revocation share this client: all or nothing with the token.
      await apply(row.user_id, {
        isUserActive: async (userId) => {
          const result = await client.query<{ is_active: boolean }>(
            'SELECT is_active FROM users WHERE id = $1',
            [userId],
          );
          return result.rows[0]?.is_active === true;
        },
        setPassword: async (userId, passwordHash) => {
          await client.query(
            'UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1',
            [userId, passwordHash],
          );
        },
        revokeAllRefreshTokens: async (userId) => {
          await client.query(
            'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
            [userId],
          );
        },
      });
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
