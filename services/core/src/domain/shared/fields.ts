import {
  QUANTITY_PATTERN,
  QUANTITY_SCALE,
  PRICE_PATTERN,
  PRICE_SCALE,
  normalizeDecimal,
} from './decimal.js';
import type { FieldIssue } from './errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Trims; records an issue when empty or longer than `max`. */
export function requiredText(
  field: string,
  label: string,
  max: number,
  value: string,
  issues: FieldIssue[],
): string {
  const text = value.trim();
  if (text.length === 0) issues.push({ field, message: `El campo ${label} es obligatorio` });
  else if (text.length > max) {
    issues.push({ field, message: `El campo ${label} admite máximo ${max} caracteres` });
  }
  return text;
}

/** Trims; empty or null becomes null; records an issue when longer than `max`. */
export function optionalText(
  field: string,
  label: string,
  max: number,
  value: string | null | undefined,
  issues: FieldIssue[],
): string | null {
  const text = value?.trim() ?? '';
  if (text.length === 0) return null;
  if (text.length > max) {
    issues.push({ field, message: `El campo ${label} admite máximo ${max} caracteres` });
  }
  return text;
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Records an issue unless `value` is a valid YYYY-MM-DD date. */
export function validDate(
  field: string,
  label: string,
  value: string,
  issues: FieldIssue[],
): string {
  if (!isValidDate(value)) {
    issues.push({ field, message: `El campo ${label} debe ser una fecha válida (AAAA-MM-DD)` });
  }
  return value;
}

export function validUuid(
  field: string,
  label: string,
  value: string,
  issues: FieldIssue[],
): string {
  if (!UUID.test(value)) issues.push({ field, message: `El campo ${label} debe ser un id válido` });
  return value.toLowerCase();
}

/** Normalizes a price (2 decimals) or records an issue. */
export function validPrice(
  field: string,
  label: string,
  value: unknown,
  issues: FieldIssue[],
): string {
  if (typeof value !== 'string' || !PRICE_PATTERN.test(value)) {
    issues.push({
      field,
      message: `El campo ${label} debe ser un texto decimal no negativo con hasta 2 decimales`,
    });
    return '0.00';
  }
  return normalizeDecimal(value, PRICE_SCALE);
}

/** Normalizes a quantity (3 decimals) or records an issue. */
export function validQuantity(
  field: string,
  label: string,
  value: unknown,
  issues: FieldIssue[],
): string {
  if (typeof value !== 'string' || !QUANTITY_PATTERN.test(value)) {
    issues.push({
      field,
      message: `El campo ${label} debe ser un texto decimal no negativo con hasta 3 decimales`,
    });
    return '0.000';
  }
  return normalizeDecimal(value, QUANTITY_SCALE);
}
