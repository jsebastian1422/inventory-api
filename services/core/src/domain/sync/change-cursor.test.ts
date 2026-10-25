import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import { decodeCursor, encodeCursor } from './change-cursor.js';

const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const token = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('change cursor', () => {
  it('round-trips and keeps the xid beyond Number precision as text', () => {
    const cursor = { xid: '18446744073709551615', id: ID };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(encodeCursor({ xid: '741', id: ID })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64url', '***'],
    ['broken JSON', Buffer.from('{oops').toString('base64url')],
    ['not an object', token(5)],
    ['null', token(null)],
    ['xid not text', token({ x: 5, i: ID })],
    ['xid not digits', token({ x: '12a', i: ID })],
    ['xid above 64 bits', token({ x: '18446744073709551616', i: ID })],
    ['negative xid', token({ x: '-1', i: ID })],
    ['bad uuid', token({ x: '1', i: 'nope' })],
    ['missing uuid', token({ x: '1' })],
  ])('rejects %s with a 400 on field cursor', (_name, value) => {
    try {
      decodeCursor(value);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).kind).toBe('validation');
      expect((error as DomainError).details?.[0]?.field).toBe('cursor');
    }
  });
});
