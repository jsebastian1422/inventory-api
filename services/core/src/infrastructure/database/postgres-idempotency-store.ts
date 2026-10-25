import type { Pool } from 'pg';
import {
  IDEMPOTENCY_STALE_MS,
  IDEMPOTENCY_TTL_MS,
  type IdempotencyStore,
  type ReserveResult,
} from '../../domain/sync/idempotency.js';

interface KeyRow {
  request_hash: string;
  state: 'in_progress' | 'completed';
  status_code: number | null;
  response: unknown;
}

/** Max attempts when a competing release/expiry changes the row between the insert and the read. */
const MAX_ATTEMPTS = 3;

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async reserve(
    actorId: string,
    key: string,
    requestHash: string,
    now: Date,
  ): Promise<ReserveResult> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Inserts, or takes over an expired or abandoned reservation; no row means "taken".
      const taken = await this.pool.query(
        `INSERT INTO idempotency_keys (actor_id, key, request_hash, state, created_at, expires_at)
         VALUES ($1, $2, $3, 'in_progress', $4::timestamptz,
                 $4::timestamptz + ($5::bigint * interval '1 millisecond'))
         ON CONFLICT (actor_id, key) DO UPDATE SET
           request_hash = EXCLUDED.request_hash, state = 'in_progress', status_code = NULL,
           response = NULL, created_at = EXCLUDED.created_at, expires_at = EXCLUDED.expires_at
         WHERE idempotency_keys.expires_at <= $4::timestamptz
            OR (idempotency_keys.state = 'in_progress'
                AND idempotency_keys.created_at <= $4::timestamptz
                    - ($6::bigint * interval '1 millisecond'))
         RETURNING 1`,
        [actorId, key, requestHash, now, IDEMPOTENCY_TTL_MS, IDEMPOTENCY_STALE_MS],
      );
      if (taken.rowCount === 1) return { kind: 'new' };

      const { rows } = await this.pool.query<KeyRow>(
        `SELECT request_hash, state, status_code, response FROM idempotency_keys
         WHERE actor_id = $1 AND key = $2`,
        [actorId, key],
      );
      const row = rows[0];
      if (!row) continue; // released meanwhile: try to reserve again
      if (row.request_hash.trim() !== requestHash) return { kind: 'mismatch' };
      if (row.state === 'completed') {
        return { kind: 'replay', statusCode: row.status_code ?? 200, response: row.response };
      }
      return { kind: 'in_progress' };
    }
    return { kind: 'in_progress' };
  }

  async complete(
    actorId: string,
    key: string,
    statusCode: number,
    response: unknown,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE idempotency_keys SET state = 'completed', status_code = $3, response = $4::jsonb
       WHERE actor_id = $1 AND key = $2`,
      [actorId, key, statusCode, JSON.stringify(response ?? null)],
    );
  }

  async release(actorId: string, key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys WHERE actor_id = $1 AND key = $2 AND state = 'in_progress'`,
      [actorId, key],
    );
  }

  async purgeExpired(now: Date, limit: number): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys WHERE (actor_id, key) IN (
         SELECT actor_id, key FROM idempotency_keys WHERE expires_at <= $1::timestamptz LIMIT $2)`,
      [now, limit],
    );
  }
}
