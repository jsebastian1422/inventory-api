import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import {
  initialChanged,
  normalizeLineChanges,
  normalizeNewLine,
  type InventoryLine,
} from './inventory-line.js';

const PRODUCT = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const base = {
  productId: PRODUCT,
  barcode: ' 7701234 ',
  quantityInitial: '10.5',
  quantityAlert: '2',
};

const fields = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).details?.map((d) => d.field).sort();
  }
  return undefined;
};

describe('inventory line normalization', () => {
  it('trims the barcode, normalizes quantities to 3 decimals and defaults the expiry to null', () => {
    expect(normalizeNewLine(base)).toEqual({
      productId: PRODUCT,
      barcode: '7701234',
      expiresOn: null,
      quantityInitial: '10.500',
      quantityAlert: '2.000',
    });
  });

  it('rejects bad quantities, barcode and dates', () => {
    expect(fields(() => normalizeNewLine({ ...base, quantityInitial: '1.2345' }))).toEqual([
      'quantityInitial',
    ]);
    expect(fields(() => normalizeNewLine({ ...base, quantityAlert: '-1' }))).toEqual([
      'quantityAlert',
    ]);
    expect(fields(() => normalizeNewLine({ ...base, barcode: 'x'.repeat(65) }))).toEqual([
      'barcode',
    ]);
    expect(fields(() => normalizeNewLine({ ...base, expiresOn: '2026-13-01' }))).toEqual([
      'expiresOn',
    ]);
    expect(normalizeLineChanges({ expiresOn: '  ' }).expiresOn).toBeNull();
  });

  it('detects an initial quantity change exactly', () => {
    const current = { quantityInitial: '0.300' } as InventoryLine;
    expect(initialChanged(current, normalizeLineChanges({ quantityInitial: '0.3' }))).toBe(false);
    expect(initialChanged(current, normalizeLineChanges({ quantityInitial: '0.301' }))).toBe(true);
    expect(initialChanged(current, normalizeLineChanges({ quantityAlert: '1' }))).toBe(false);
  });
});
