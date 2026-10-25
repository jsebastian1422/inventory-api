import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRequest } from './idempotency.js';

describe('canonicalJson', () => {
  it('sorts keys at every level and ignores undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[{"x":2,"y":1}]},"b":1}',
    );
  });
});

describe('hashRequest', () => {
  const base = { method: 'patch', path: '/x/1', body: { a: 1, b: 2 } };

  it('is stable for the same content regardless of key order and method case', () => {
    expect(hashRequest(base)).toBe(hashRequest({ ...base, method: 'PATCH', body: { b: 2, a: 1 } }));
    expect(hashRequest(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with method, path, body or extra headers', () => {
    const h = hashRequest(base);
    expect(hashRequest({ ...base, method: 'POST' })).not.toBe(h);
    expect(hashRequest({ ...base, path: '/x/2' })).not.toBe(h);
    expect(hashRequest({ ...base, body: { a: 1, b: 3 } })).not.toBe(h);
    expect(hashRequest({ ...base, extra: { 'if-match': '"2"' } })).not.toBe(h);
  });
});
