import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import {
  buildMapsUrl,
  normalizeChanges,
  normalizeNewEstablishment,
  type EstablishmentInput,
} from './establishment.js';

const valid: EstablishmentInput = {
  name: '  Multipartes - Sede Norte ',
  address: ' Cra 10 # 20-30 ',
  city: ' Medellín ',
  department: ' Antioquia ',
  phone: '   ',
  latitude: 6.25184,
  longitude: -75.563591,
};

function fieldsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return (error.details ?? []).map((d) => d.field);
    throw error;
  }
  return [];
}

describe('normalizeNewEstablishment', () => {
  it('trims texts and turns an empty phone into null', () => {
    expect(normalizeNewEstablishment(valid)).toEqual({
      name: 'Multipartes - Sede Norte',
      address: 'Cra 10 # 20-30',
      city: 'Medellín',
      department: 'Antioquia',
      phone: null,
      latitude: 6.25184,
      longitude: -75.563591,
    });
  });

  it('rounds coordinates to 6 decimals', () => {
    const data = normalizeNewEstablishment({
      ...valid,
      latitude: 1.23456789,
      longitude: -2.1234564,
    });
    expect(data.latitude).toBe(1.234568);
    expect(data.longitude).toBe(-2.123456);
  });

  it('rejects fields empty after trim', () => {
    expect(fieldsOf(() => normalizeNewEstablishment({ ...valid, name: '   ', city: '' }))).toEqual([
      'name',
      'city',
    ]);
  });

  it('rejects texts over the limit after trim and accepts the limit exactly', () => {
    expect(fieldsOf(() => normalizeNewEstablishment({ ...valid, name: 'a'.repeat(151) }))).toEqual([
      'name',
    ]);
    expect(normalizeNewEstablishment({ ...valid, name: ` ${'a'.repeat(150)} ` }).name).toHaveLength(
      150,
    );
  });

  it('rejects coordinates out of range', () => {
    expect(fieldsOf(() => normalizeNewEstablishment({ ...valid, latitude: 90.5 }))).toEqual([
      'latitude',
    ]);
    expect(fieldsOf(() => normalizeNewEstablishment({ ...valid, longitude: -180.5 }))).toEqual([
      'longitude',
    ]);
    expect(normalizeNewEstablishment({ ...valid, latitude: -90, longitude: 180 }).longitude).toBe(
      180,
    );
  });

  it('rejects a phone with disallowed characters', () => {
    expect(fieldsOf(() => normalizeNewEstablishment({ ...valid, phone: '555-abc' }))).toEqual([
      'phone',
    ]);
    expect(normalizeNewEstablishment({ ...valid, phone: ' +57 (604) 555-0000 ' }).phone).toBe(
      '+57 (604) 555-0000',
    );
  });
});

describe('normalizeChanges', () => {
  it('returns only the provided fields and lets phone be cleared', () => {
    expect(normalizeChanges({ city: ' Cali ', phone: null })).toEqual({
      city: 'Cali',
      phone: null,
    });
  });
});

describe('buildMapsUrl', () => {
  it('uses the official Maps URLs format', () => {
    expect(buildMapsUrl(6.25184, -75.563591)).toBe(
      'https://www.google.com/maps/search/?api=1&query=6.25184,-75.563591',
    );
  });
});
