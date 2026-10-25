import { validationError } from './errors.js';

/**
 * Exact decimals kept as text (ADR-0003). Values are handled as scaled BigInt, never as `Number`.
 * `scale` is the fixed number of decimals (2 for prices, 3 for quantities).
 */

/** Pattern of a non-negative decimal with up to `intDigits` integer digits and `scale` decimals. */
export function decimalPattern(intDigits: number, scale: number): RegExp {
  return new RegExp(`^\\d{1,${intDigits}}(\\.\\d{1,${scale}})?$`);
}

/** Price input: up to 12 integer digits and 2 decimals (numeric(14,2)). */
export const PRICE_PATTERN = decimalPattern(12, 2);
/** Quantity input: up to 11 integer digits and 3 decimals (numeric(14,3)). */
export const QUANTITY_PATTERN = decimalPattern(11, 3);

export const PRICE_SCALE = 2;
export const QUANTITY_SCALE = 3;

/** Largest quantity that fits numeric(14,3), in thousandths. */
export const MAX_QUANTITY_UNITS = 10n ** 14n - 1n;

/** Converts text with at most `scale` decimals (optionally negative) to scaled integer units. */
export function toUnits(text: string, scale: number): bigint {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const units = BigInt(whole + fraction.padEnd(scale, '0'));
  return negative ? -units : units;
}

/** Formats scaled integer units as canonical text with exactly `scale` decimals. */
export function fromUnits(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  const body = scale > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${body}` : body;
}

/** Canonical text of `text` with exactly `scale` decimals ("10.5" -> "10.500"). */
export function normalizeDecimal(text: string, scale: number): string {
  return fromUnits(toUnits(text, scale), scale);
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareDecimal(a: string, b: string, scale: number): number {
  const x = toUnits(a, scale);
  const y = toUnits(b, scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: string, b: string, scale: number): string {
  return fromUnits(toUnits(a, scale) + toUnits(b, scale), scale);
}

export function subtractDecimal(a: string, b: string, scale: number): string {
  return fromUnits(toUnits(a, scale) - toUnits(b, scale), scale);
}

/** True when the text is negative (after normalization it is below zero). */
export function isNegativeDecimal(text: string, scale: number): boolean {
  return toUnits(text, scale) < 0n;
}

/** Validates a price/quantity input and returns it normalized; throws a 400 on `field` otherwise. */
export function parseDecimalInput(
  field: string,
  label: string,
  value: unknown,
  pattern: RegExp,
  scale: number,
): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw validationError('Datos inválidos', [
      {
        field,
        message: `El campo ${label} debe ser un texto decimal no negativo con hasta ${scale} decimales`,
      },
    ]);
  }
  return normalizeDecimal(value, scale);
}
