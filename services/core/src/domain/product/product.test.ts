import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import {
  normalizeNewProduct,
  normalizeProductChanges,
  priceChanged,
  type Product,
} from './product.js';

const CATEGORY = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const base = {
  sku: ' ab-1 ',
  name: ' Martillo ',
  unit: 'unit',
  categoryId: CATEGORY,
  price: '12500',
};

const fields = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).details?.map((d) => d.field).sort();
  }
  return undefined;
};

describe('product normalization', () => {
  it('trims, uppercases the SKU and keeps the price as exact text with 2 decimals', () => {
    const data = normalizeNewProduct(base);
    expect(data).toMatchObject({
      sku: 'AB-1',
      name: 'Martillo',
      price: '12500.00',
      description: null,
      brand: null,
    });
  });

  it('rejects an unknown unit, a bad price and a bad category id', () => {
    expect(fields(() => normalizeNewProduct({ ...base, unit: 'pallet' }))).toEqual(['unit']);
    expect(fields(() => normalizeNewProduct({ ...base, price: '1.234' }))).toEqual(['price']);
    expect(fields(() => normalizeNewProduct({ ...base, price: '-1' }))).toEqual(['price']);
    expect(fields(() => normalizeNewProduct({ ...base, price: 5 as unknown as string }))).toEqual([
      'price',
    ]);
    expect(fields(() => normalizeNewProduct({ ...base, categoryId: 'x' }))).toEqual(['categoryId']);
  });

  it('compares prices exactly, regardless of the written scale', () => {
    const current = { price: '10.50' } as Product;
    expect(priceChanged(current, normalizeProductChanges({ price: '10.5' }))).toBe(false);
    expect(priceChanged(current, normalizeProductChanges({ price: '10.51' }))).toBe(true);
    expect(priceChanged(current, normalizeProductChanges({ name: 'x' }))).toBe(false);
  });
});
