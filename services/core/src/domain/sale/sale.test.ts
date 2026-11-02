import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import {
  canReadSales,
  canSell,
  customerLabel,
  FINAL_CONSUMER,
  isSeller,
  normalizeCustomer,
  readsAllSales,
} from './sale.js';

const actor = (userId: string, ...permissions: string[]) => ({ userId, permissions });

function issues(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    if (error instanceof DomainError && error.code === 'VALIDATION_ERROR') {
      return (error.details ?? []).map((d) => (d as { field: string }).field);
    }
    throw error;
  }
  return [];
}

const valid = { docType: 'NIT', docNumber: '9001234567', name: ' Ferretería Sur ' };

describe('normalizeCustomer (R-7)', () => {
  it('no buyer is Consumidor final', () => {
    expect(normalizeCustomer(undefined)).toBeNull();
    expect(normalizeCustomer(null)).toBeNull();
    expect(customerLabel({ customer: null })).toBe(FINAL_CONSUMER);
  });

  it('trims, keeps email and phone optional', () => {
    expect(normalizeCustomer(valid)).toEqual({
      docType: 'NIT',
      docNumber: '9001234567',
      name: 'Ferretería Sur',
      email: null,
      phone: null,
    });
    expect(
      normalizeCustomer({ ...valid, email: ' a@b.co ', phone: '+57 (300) 123-4567' }),
    ).toMatchObject({ email: 'a@b.co', phone: '+57 (300) 123-4567' });
    expect(normalizeCustomer({ ...valid, email: '  ', phone: '' })).toMatchObject({
      email: null,
      phone: null,
    });
    expect(customerLabel({ customer: normalizeCustomer(valid) })).toBe('Ferretería Sur');
  });

  it('every document type of the list is accepted, others are not', () => {
    for (const docType of ['CC', 'CE', 'NIT', 'PAS', 'TI']) {
      expect(normalizeCustomer({ ...valid, docType })).not.toBeNull();
    }
    expect(issues(() => normalizeCustomer({ ...valid, docType: 'cc' }))).toEqual([
      'customer.docType',
    ]);
    expect(issues(() => normalizeCustomer({ ...valid, docType: 'XX' }))).toEqual([
      'customer.docType',
    ]);
  });

  it('type without number, number without name, empty name', () => {
    expect(issues(() => normalizeCustomer({ docType: 'CC', name: 'Ana' }))).toEqual([
      'customer.docNumber',
    ]);
    expect(issues(() => normalizeCustomer({ docType: 'CC', docNumber: '1' }))).toEqual([
      'customer.name',
    ]);
    expect(issues(() => normalizeCustomer({ ...valid, name: '   ' }))).toEqual(['customer.name']);
    expect(issues(() => normalizeCustomer({}))).toEqual([
      'customer.docType',
      'customer.docNumber',
      'customer.name',
    ]);
  });

  it('limits and formats', () => {
    expect(issues(() => normalizeCustomer({ ...valid, docNumber: '1'.repeat(21) }))).toEqual([
      'customer.docNumber',
    ]);
    expect(issues(() => normalizeCustomer({ ...valid, docNumber: '12 34' }))).toEqual([
      'customer.docNumber',
    ]);
    expect(normalizeCustomer({ ...valid, docNumber: '900123456-7' }).docNumber).toBe('900123456-7');
    for (const bad of ['-123', '123-', '12--3', '---']) {
      expect(issues(() => normalizeCustomer({ ...valid, docNumber: bad }))).toEqual([
        'customer.docNumber',
      ]);
    }
    expect(issues(() => normalizeCustomer({ ...valid, name: 'x'.repeat(151) }))).toEqual([
      'customer.name',
    ]);
    expect(issues(() => normalizeCustomer({ ...valid, email: 'no-es-correo' }))).toEqual([
      'customer.email',
    ]);
    expect(issues(() => normalizeCustomer({ ...valid, email: `${'a'.repeat(250)}@b.co` }))).toEqual(
      ['customer.email'],
    );
    expect(issues(() => normalizeCustomer({ ...valid, phone: 'abc' }))).toEqual(['customer.phone']);
    expect(issues(() => normalizeCustomer({ ...valid, name: 5 }))).toEqual(['customer.name']);
  });
});

describe('who sells and who reads', () => {
  it('permissions and seller identity (case-insensitive)', () => {
    expect(canSell(actor('u', 'sales.create'))).toBe(true);
    expect(canSell(actor('u', 'sales.read'))).toBe(false);
    expect(canReadSales(actor('u', 'sales.read'))).toBe(true);
    expect(readsAllSales(actor('u', 'sales.read'))).toBe(false);
    expect(readsAllSales(actor('u', 'sales.read', 'establishments.all'))).toBe(true);
    expect(readsAllSales(actor('u', 'establishments.all'))).toBe(false);
    expect(isSeller({ sellerId: 'AAA' }, actor('aaa'))).toBe(true);
    expect(isSeller({ sellerId: 'aaa' }, actor('bbb'))).toBe(false);
  });
});
