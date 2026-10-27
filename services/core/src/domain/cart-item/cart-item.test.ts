import { describe, expect, it } from 'vitest';
import { positiveQuantity } from './cart-item.js';

describe('positiveQuantity', () => {
  it('normalizes to 3 decimals', () => {
    expect(positiveQuantity('3')).toBe('3.000');
    expect(positiveQuantity('0.001')).toBe('0.001');
    expect(positiveQuantity('12.5')).toBe('12.500');
  });

  it.each(['0', '0.000', '-1', '1.2345', 'abc', '', '1e3', 3, null, undefined])(
    'rejects %s with a 400 on `quantity`',
    (value) => {
      expect(() => positiveQuantity(value)).toThrowError(
        expect.objectContaining({ kind: 'validation' }),
      );
    },
  );
});
