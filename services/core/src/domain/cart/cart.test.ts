import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import { canReadOthersCarts, cartAccess, type Cart } from './cart.js';

const cart: Cart = {
  id: 'c1',
  establishmentId: 'e1',
  createdBy: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  status: 'open',
  cancelledBy: null,
  cancelledAt: null,
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const actor = (userId: string, ...permissions: string[]) => ({ userId, permissions });

function code(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof DomainError ? `${error.kind}:${error.code}` : 'other';
  }
  return undefined;
}

describe('canReadOthersCarts', () => {
  it('needs carts.read AND establishments.all', () => {
    expect(canReadOthersCarts(actor('u', 'carts.read', 'establishments.all'))).toBe(true);
    expect(canReadOthersCarts(actor('u', 'carts.read'))).toBe(false);
    expect(canReadOthersCarts(actor('u', 'establishments.all', 'carts.use'))).toBe(false);
  });
});

describe('cartAccess', () => {
  it('owner with carts.use (id compared case-insensitively)', () => {
    expect(cartAccess(cart, actor(cart.createdBy.toUpperCase(), 'carts.use'))).toBe('owner');
  });

  it('owner without carts.use is a 403', () => {
    expect(code(() => cartAccess(cart, actor(cart.createdBy)))).toBe('forbidden:FORBIDDEN');
  });

  it('foreign cart: reader, or 404 CART_NOT_FOUND without revealing it', () => {
    expect(cartAccess(cart, actor('other', 'carts.read', 'establishments.all'))).toBe('reader');
    expect(code(() => cartAccess(cart, actor('other', 'carts.use')))).toBe(
      'not_found:CART_NOT_FOUND',
    );
    expect(code(() => cartAccess(null, actor('other', 'carts.use')))).toBe(
      'not_found:CART_NOT_FOUND',
    );
  });
});
