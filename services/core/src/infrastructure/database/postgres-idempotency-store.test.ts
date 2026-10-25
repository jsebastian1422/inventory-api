import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IDEMPOTENCY_STALE_MS, IDEMPOTENCY_TTL_MS } from '../../domain/sync/idempotency.js';
import { connectTestDatabase } from '../../testing/test-database.js';
import { PostgresIdempotencyStore } from './postgres-idempotency-store.js';

/** Real PostgreSQL (the _test database). Each test uses fresh actor and key ids. */
let pool: Pool;
let store: PostgresIdempotencyStore;
const HASH = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

beforeAll(() => {
  pool = connectTestDatabase();
  store = new PostgresIdempotencyStore(pool);
});

afterAll(async () => {
  await pool?.end();
});

describe('PostgresIdempotencyStore', () => {
  it('reserves, rejects a second reservation while running and replays after completion', async () => {
    const actor = randomUUID();
    const key = randomUUID();
    const now = new Date();
    expect(await store.reserve(actor, key, HASH, now)).toEqual({ kind: 'new' });
    expect(await store.reserve(actor, key, HASH, now)).toEqual({ kind: 'in_progress' });
    expect(await store.reserve(actor, key, OTHER, now)).toEqual({ kind: 'mismatch' });
    await store.complete(actor, key, 201, { id: 'x', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(await store.reserve(actor, key, HASH, now)).toEqual({
      kind: 'replay',
      statusCode: 201,
      response: { id: 'x', createdAt: '2026-01-01T00:00:00.000Z' },
    });
    expect(await store.reserve(actor, key, OTHER, now)).toEqual({ kind: 'mismatch' });
  });

  it('scopes keys by actor', async () => {
    const key = randomUUID();
    const now = new Date();
    expect(await store.reserve(randomUUID(), key, HASH, now)).toEqual({ kind: 'new' });
    expect(await store.reserve(randomUUID(), key, HASH, now)).toEqual({ kind: 'new' });
  });

  it('release lets a retry reserve again, but never drops a completed key', async () => {
    const actor = randomUUID();
    const key = randomUUID();
    const now = new Date();
    await store.reserve(actor, key, HASH, now);
    await store.release(actor, key);
    expect(await store.reserve(actor, key, OTHER, now)).toEqual({ kind: 'new' });
    await store.complete(actor, key, 200, { ok: true });
    await store.release(actor, key);
    expect((await store.reserve(actor, key, HASH, now)).kind).toBe('mismatch');
  });

  it('takes over an abandoned in_progress reservation after 60 s', async () => {
    const actor = randomUUID();
    const key = randomUUID();
    const start = new Date();
    await store.reserve(actor, key, HASH, start);
    const early = new Date(start.getTime() + IDEMPOTENCY_STALE_MS - 1000);
    expect((await store.reserve(actor, key, HASH, early)).kind).toBe('in_progress');
    const late = new Date(start.getTime() + IDEMPOTENCY_STALE_MS + 1000);
    expect(await store.reserve(actor, key, OTHER, late)).toEqual({ kind: 'new' });
  });

  it('treats an expired key as non-existent and purges expired keys in bounded batches', async () => {
    const actor = randomUUID();
    const key = randomUUID();
    const start = new Date();
    await store.reserve(actor, key, HASH, start);
    await store.complete(actor, key, 200, { ok: true });
    const expired = new Date(start.getTime() + IDEMPOTENCY_TTL_MS + 1000);
    expect(await store.reserve(actor, key, OTHER, expired)).toEqual({ kind: 'new' });

    const old = randomUUID();
    await store.reserve(
      old,
      randomUUID(),
      HASH,
      new Date(start.getTime() - 2 * IDEMPOTENCY_TTL_MS),
    );
    await store.purgeExpired(start, 100);
    const { rows } = await pool.query('SELECT 1 FROM idempotency_keys WHERE actor_id = $1', [old]);
    expect(rows).toHaveLength(0);
  });

  it('simultaneous reservations: exactly one wins', async () => {
    const actor = randomUUID();
    const key = randomUUID();
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.reserve(actor, key, HASH, now)),
    );
    expect(results.filter((r) => r.kind === 'new')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'in_progress')).toHaveLength(7);
  });
});
