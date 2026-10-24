import type { Pool } from 'pg';
import type { RefreshTokenRecord, RefreshTokenRepository } from '../../domain/auth/ports.js';

interface TokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
}

const toRecord = (row: TokenRow): RefreshTokenRecord => ({
  id: row.id,
  userId: row.user_id,
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
});

const COLUMNS = 'id, user_id, token_hash, expires_at, revoked_at';

export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly pool: Pool) {}

  async create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const { rows } = await this.pool.query<TokenRow>(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)
       RETURNING ${COLUMNS}`,
      [data.userId, data.tokenHash, data.expiresAt],
    );
    return toRecord(rows[0]!);
  }

  async findByHash(hash: string): Promise<RefreshTokenRecord | null> {
    const { rows } = await this.pool.query<TokenRow>(
      `SELECT ${COLUMNS} FROM refresh_tokens WHERE token_hash = $1`,
      [hash],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async rotate(
    oldId: string,
    data: { userId: string; tokenHash: string; expiresAt: Date },
  ): Promise<RefreshTokenRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const revoked = await client.query(
        'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
        [oldId],
      );
      if (revoked.rowCount === 0) {
        await client.query('ROLLBACK');
        return null;
      }
      const { rows } = await client.query<TokenRow>(
        `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)
         RETURNING ${COLUMNS}`,
        [data.userId, data.tokenHash, data.expiresAt],
      );
      await client.query('UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1', [
        oldId,
        rows[0]!.id,
      ]);
      await client.query('COMMIT');
      return toRecord(rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async revoke(id: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL',
      [id],
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.pool.query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }
}
