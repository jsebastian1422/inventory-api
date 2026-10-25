import { describe, expect, it } from 'vitest';
import {
  addDecimal,
  compareDecimal,
  fromUnits,
  isNegativeDecimal,
  normalizeDecimal,
  PRICE_PATTERN,
  PRICE_SCALE,
  QUANTITY_PATTERN,
  QUANTITY_SCALE,
  subtractDecimal,
  toUnits,
} from './decimal.js';

describe('decimal text arithmetic (ADR-0003)', () => {
  it('adds 0.1 and 0.2 exactly', () => {
    expect(addDecimal('0.1', '0.2', QUANTITY_SCALE)).toBe('0.300');
    expect(addDecimal('0.10', '0.20', PRICE_SCALE)).toBe('0.30');
    expect(compareDecimal(addDecimal('0.1', '0.2', 3), '0.3', 3)).toBe(0);
  });

  it('subtracts to negative results and formats the sign', () => {
    expect(subtractDecimal('0.100', '0.300', QUANTITY_SCALE)).toBe('-0.200');
    expect(isNegativeDecimal('-0.200', QUANTITY_SCALE)).toBe(true);
    expect(isNegativeDecimal('0.000', QUANTITY_SCALE)).toBe(false);
    expect(subtractDecimal('1.000', '1.000', QUANTITY_SCALE)).toBe('0.000');
  });

  it('normalizes to the fixed scale and drops leading zeros', () => {
    expect(normalizeDecimal('10.5', 3)).toBe('10.500');
    expect(normalizeDecimal('12500', 2)).toBe('12500.00');
    expect(normalizeDecimal('007.5', 2)).toBe('7.50');
    expect(normalizeDecimal('0', 3)).toBe('0.000');
  });

  it('keeps the maximum values exact (beyond Number precision)', () => {
    expect(normalizeDecimal('999999999999.99', 2)).toBe('999999999999.99');
    expect(normalizeDecimal('99999999999.999', 3)).toBe('99999999999.999');
    expect(addDecimal('99999999999.998', '0.001', 3)).toBe('99999999999.999');
    expect(toUnits('99999999999.999', 3)).toBe(99999999999999n);
    expect(fromUnits(-5n, 3)).toBe('-0.005');
  });

  it('compares exactly', () => {
    expect(compareDecimal('10.5', '10.500', 3)).toBe(0);
    expect(compareDecimal('0.001', '0.000', 3)).toBeGreaterThan(0);
    expect(compareDecimal('1.99', '2.00', 2)).toBeLessThan(0);
  });
});

describe('input patterns', () => {
  it.each(['0', '12500', '12500.5', '12500.50', '999999999999.99', '0.01'])(
    'price accepts %s',
    (value) => expect(PRICE_PATTERN.test(value)).toBe(true),
  );
  it.each(['', '-1', '1e3', '1.234', '1,000.00', '.5', '5.', '1000000000000', ' 5', '1 ', '+5'])(
    'price rejects "%s"',
    (value) => expect(PRICE_PATTERN.test(value)).toBe(false),
  );
  it.each(['0', '10.5', '10.500', '99999999999.999'])('quantity accepts %s', (value) =>
    expect(QUANTITY_PATTERN.test(value)).toBe(true),
  );
  it.each(['-0.1', '1.2345', '1e2', '100000000000', '1,5', ''])('quantity rejects "%s"', (value) =>
    expect(QUANTITY_PATTERN.test(value)).toBe(false),
  );
});
