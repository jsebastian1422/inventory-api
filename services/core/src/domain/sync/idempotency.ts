import { createHash } from 'node:crypto';

/** Retention of a stored key. */
export const IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** An `in_progress` reservation older than this is considered abandoned (process crash). */
export const IDEMPOTENCY_STALE_MS = 60 * 1000;
/** Max expired keys purged per reservation. */
export const IDEMPOTENCY_PURGE_BATCH = 100;

/** Result of trying to reserve a key. */
export type ReserveResult =
  | { readonly kind: 'new' }
  | { readonly kind: 'replay'; readonly statusCode: number; readonly response: unknown }
  | { readonly kind: 'mismatch' }
  | { readonly kind: 'in_progress' };

/** Port: storage of idempotency keys, scoped by actor. */
export interface IdempotencyStore {
  /** Atomic: reserves the key, or says why it cannot (stored result, other content, running). */
  reserve(actorId: string, key: string, requestHash: string, now: Date): Promise<ReserveResult>;
  /** Stores the successful result of a reserved key. */
  complete(actorId: string, key: string, statusCode: number, response: unknown): Promise<void>;
  /** Drops an `in_progress` reservation so a retry is evaluated again. */
  release(actorId: string, key: string): Promise<void>;
  /** Deletes up to `limit` expired keys. */
  purgeExpired(now: Date, limit: number): Promise<void>;
}

/** JSON with object keys sorted at every level (stable for hashing). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

export interface RequestFingerprint {
  readonly method: string;
  /** Path with its parameters, without the query string. */
  readonly path: string;
  readonly body: unknown;
  /** Other headers that change the meaning of the request (If-Match). */
  readonly extra?: Readonly<Record<string, string | undefined>>;
}

/** SHA-256 (hex) of method, path, canonical body and extra headers. */
export function hashRequest(request: RequestFingerprint): string {
  const material = canonicalJson({
    method: request.method.toUpperCase(),
    path: request.path,
    body: request.body ?? null,
    extra: request.extra ?? {},
  });
  return createHash('sha256').update(material).digest('hex');
}
