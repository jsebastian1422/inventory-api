import { describe, expect, it } from 'vitest';
import { DomainError } from '../shared/errors.js';
import { normalizeCategoryChanges, normalizeNewCategory } from './category.js';

const fields = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return (error as DomainError).details?.map((d) => d.field).sort();
  }
  return undefined;
};

describe('category normalization', () => {
  it('trims, uppercases the code and turns an empty description into null', () => {
    expect(
      normalizeNewCategory({ code: '  herr-mano ', name: ' Herramientas ', description: '  ' }),
    ).toEqual({
      code: 'HERR-MANO',
      name: 'Herramientas',
      description: null,
    });
  });

  it('rejects an invalid code, empty name and too-long texts, listing each field', () => {
    expect(fields(() => normalizeNewCategory({ code: 'a b', name: ' ' }))).toEqual([
      'code',
      'name',
    ]);
    expect(fields(() => normalizeNewCategory({ code: 'A'.repeat(31), name: 'x' }))).toEqual([
      'code',
    ]);
    expect(
      fields(() =>
        normalizeNewCategory({ code: 'A', name: 'x'.repeat(101), description: 'd'.repeat(501) }),
      ),
    ).toEqual(['description', 'name']);
  });

  it('accepts the limits and normalizes only the provided fields', () => {
    expect(normalizeCategoryChanges({ code: 'a'.repeat(30) }).code).toBe('A'.repeat(30));
    expect(normalizeCategoryChanges({ description: null })).toEqual({ description: null });
  });
});
