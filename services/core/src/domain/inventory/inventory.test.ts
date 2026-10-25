import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import {
  assertEditedDates,
  normalizeInventoryChanges,
  normalizeNewInventory,
  type Inventory,
} from './inventory.js';

const EST = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const base = {
  establishmentId: EST,
  name: ' Inventario inicial ',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  origin: ' Proveedor X ',
};

const fields = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).details?.map((d) => d.field).sort();
  }
  return undefined;
};

describe('inventory normalization', () => {
  it('trims texts and accepts equal dates', () => {
    expect(normalizeNewInventory({ ...base, endDate: '2026-01-01' })).toMatchObject({
      name: 'Inventario inicial',
      origin: 'Proveedor X',
      notes: null,
    });
  });

  it('rejects end before start, impossible dates and a missing origin', () => {
    expect(fields(() => normalizeNewInventory({ ...base, endDate: '2025-12-31' }))).toEqual([
      'endDate',
    ]);
    expect(fields(() => normalizeNewInventory({ ...base, startDate: '2026-02-30' }))).toEqual([
      'startDate',
    ]);
    expect(fields(() => normalizeNewInventory({ ...base, endDate: '2026-1-5' }))).toEqual([
      'endDate',
    ]);
    expect(fields(() => normalizeNewInventory({ ...base, origin: ' ' }))).toEqual(['origin']);
  });

  it('checks an edited date against the stored one', () => {
    const current = { startDate: '2026-01-10', endDate: '2026-01-20' } as Inventory;
    expect(() =>
      assertEditedDates(current, normalizeInventoryChanges({ endDate: '2026-01-09' })),
    ).toThrow(DomainError);
    expect(() =>
      assertEditedDates(current, normalizeInventoryChanges({ startDate: '2026-01-21' })),
    ).toThrow(DomainError);
    expect(() =>
      assertEditedDates(current, normalizeInventoryChanges({ endDate: '2026-01-10' })),
    ).not.toThrow();
  });
});
