import { validationError, type FieldIssue } from '../shared/errors.js';
import { optionalText, requiredText } from '../shared/fields.js';

export const CODE_MAX = 30;
export const NAME_MAX = 100;
export const DESCRIPTION_MAX = 500;
/** Uppercase letters, digits and hyphen. */
export const CODE_PATTERN = /^[A-Z0-9-]+$/;

export interface Category {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
  /** Starts at 1; +1 on each write (optimistic concurrency, ADR-0002). */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Normalized data ready to persist (trimmed, code in uppercase, description null when empty). */
export interface CategoryData {
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
}

export interface CategoryInput {
  code: string;
  name: string;
  description?: string | null;
}

/** Raw input of an edit: any subset; `description: null` clears it. */
export type CategoryChanges = Partial<CategoryInput>;

function normalizeCode(value: string, issues: FieldIssue[]): string {
  const code = requiredText('code', 'código', CODE_MAX, value, issues).toUpperCase();
  if (code.length > 0 && !CODE_PATTERN.test(code)) {
    issues.push({ field: 'code', message: 'El código solo admite letras, dígitos y guion' });
  }
  return code;
}

/** Validates and normalizes only the provided fields. Throws a 400 listing every invalid field. */
export function normalizeCategoryChanges(input: CategoryChanges): Partial<CategoryData> {
  const issues: FieldIssue[] = [];
  const out: { -readonly [K in keyof CategoryData]?: CategoryData[K] } = {};
  if (input.code !== undefined) out.code = normalizeCode(input.code, issues);
  if (input.name !== undefined) {
    out.name = requiredText('name', 'nombre', NAME_MAX, input.name, issues);
  }
  if (input.description !== undefined) {
    out.description = optionalText(
      'description',
      'descripción',
      DESCRIPTION_MAX,
      input.description,
      issues,
    );
  }
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return out;
}

/** Validates and normalizes a complete category (code and name must be present). */
export function normalizeNewCategory(input: CategoryInput): CategoryData {
  const data = normalizeCategoryChanges(input);
  return { description: null, ...data } as CategoryData;
}

/** Names of the fields in `changes` whose value differs from the current record. */
export function changedCategoryFields(current: Category, changes: Partial<CategoryData>): string[] {
  return (Object.keys(changes) as (keyof CategoryData)[]).filter(
    (key) => changes[key] !== current[key],
  );
}
