import { validationError, type FieldIssue } from '../shared/errors.js';

export const NAME_MAX = 150;
export const ADDRESS_MAX = 255;
export const CITY_MAX = 100;
export const DEPARTMENT_MAX = 100;
export const PHONE_MAX = 30;
/** Digits, plus, hyphen, parentheses and space. */
export const PHONE_PATTERN = /^[0-9+\-() ]+$/;

const COORDINATE_DECIMALS = 1e6;

export interface Establishment {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly department: string;
  readonly phone: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly isActive: boolean;
  /** Starts at 1; +1 on each effective edit or status change (optimistic concurrency, ADR-0002). */
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Normalized data ready to persist (trimmed, phone null when empty, 6-decimal coordinates). */
export interface EstablishmentData {
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly department: string;
  readonly phone: string | null;
  readonly latitude: number;
  readonly longitude: number;
}

/** Raw input of a creation (already typed by the HTTP layer). */
export interface EstablishmentInput {
  name: string;
  address: string;
  city: string;
  department: string;
  phone?: string | null;
  latitude: number;
  longitude: number;
}

/** Raw input of an edit: any subset; `phone: null` clears the phone. */
export type EstablishmentChanges = Partial<EstablishmentInput>;

const TEXT_FIELDS = [
  ['name', 'nombre', NAME_MAX],
  ['address', 'dirección', ADDRESS_MAX],
  ['city', 'ciudad', CITY_MAX],
  ['department', 'departamento', DEPARTMENT_MAX],
] as const;

type TextField = (typeof TEXT_FIELDS)[number][0];

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_DECIMALS) / COORDINATE_DECIMALS;
}

function normalizeText(
  field: TextField,
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

function normalizePhone(value: string | null | undefined, issues: FieldIssue[]): string | null {
  const phone = value?.trim() ?? '';
  if (phone.length === 0) return null;
  if (phone.length > PHONE_MAX) {
    issues.push({ field: 'phone', message: `El teléfono admite máximo ${PHONE_MAX} caracteres` });
  } else if (!PHONE_PATTERN.test(phone)) {
    issues.push({
      field: 'phone',
      message: 'El teléfono solo admite dígitos, +, -, paréntesis y espacios',
    });
  }
  return phone;
}

function normalizeCoordinate(
  field: 'latitude' | 'longitude',
  limit: number,
  value: number,
  issues: FieldIssue[],
): number {
  const label = field === 'latitude' ? 'latitud' : 'longitud';
  if (!Number.isFinite(value)) {
    issues.push({ field, message: `La ${label} debe ser un número` });
    return value;
  }
  const rounded = roundCoordinate(value);
  if (Math.abs(rounded) > limit) {
    issues.push({ field, message: `La ${label} debe estar entre -${limit} y ${limit}` });
  }
  return rounded;
}

/** Validates and normalizes only the provided fields. Throws a 400 listing every invalid field. */
export function normalizeChanges(input: EstablishmentChanges): Partial<EstablishmentData> {
  const issues: FieldIssue[] = [];
  const out: { -readonly [K in keyof EstablishmentData]?: EstablishmentData[K] } = {};
  for (const [field, label, max] of TEXT_FIELDS) {
    const value = input[field];
    if (value !== undefined) out[field] = normalizeText(field, label, max, value, issues);
  }
  if (input.phone !== undefined) out.phone = normalizePhone(input.phone, issues);
  if (input.latitude !== undefined) {
    out.latitude = normalizeCoordinate('latitude', 90, input.latitude, issues);
  }
  if (input.longitude !== undefined) {
    out.longitude = normalizeCoordinate('longitude', 180, input.longitude, issues);
  }
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return out;
}

/** Validates and normalizes a complete establishment (all required fields must be present). */
export function normalizeNewEstablishment(input: EstablishmentInput): EstablishmentData {
  const data = normalizeChanges(input);
  return { phone: null, ...data } as EstablishmentData;
}

/** Google "Maps URLs" link (no API key needed) for the coordinates. */
export function buildMapsUrl(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

/** Names of the fields in `changes` whose value differs from the current establishment. */
export function changedFields(
  current: Establishment,
  changes: Partial<EstablishmentData>,
): string[] {
  return (Object.keys(changes) as (keyof EstablishmentData)[]).filter(
    (key) => changes[key] !== current[key],
  );
}
