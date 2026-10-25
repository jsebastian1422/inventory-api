import { validationError } from '../shared/errors.js';

/** Position in a change feed: PostgreSQL xid8 (kept as text, never as Number) plus record id. */
export interface ChangeCursor {
  readonly xid: string;
  readonly id: string;
}

/** A page read from the repository; `last` is the position of the last returned item. */
export interface ChangeBatch<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly last: ChangeCursor | null;
}

/** Public page of a feed: `nextCursor` is opaque. */
export interface ChangePage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

const MAX_XID8 = 2n ** 64n - 1n;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const DIGITS = /^\d{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encodes a cursor as base64url of `{"x":"<xid8>","i":"<uuid>"}`. */
export function encodeCursor(cursor: ChangeCursor): string {
  return Buffer.from(JSON.stringify({ x: cursor.xid, i: cursor.id }), 'utf8').toString('base64url');
}

const invalid = () =>
  validationError('Datos inválidos', [{ field: 'cursor', message: 'Cursor inválido' }]);

/** Decodes and validates a cursor. Throws a 400 (field `cursor`) when malformed. */
export function decodeCursor(token: string): ChangeCursor {
  if (!BASE64URL.test(token)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { x, i } = parsed as { x?: unknown; i?: unknown };
  if (typeof x !== 'string' || !DIGITS.test(x) || BigInt(x) > MAX_XID8) throw invalid();
  if (typeof i !== 'string' || !UUID.test(i)) throw invalid();
  return { xid: x, id: i.toLowerCase() };
}
