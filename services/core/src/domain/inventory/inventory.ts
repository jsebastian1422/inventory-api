import { validationError, type FieldIssue } from '../shared/errors.js';
import { optionalText, requiredText, validDate, validUuid } from '../shared/fields.js';

export const NAME_MAX = 150;
export const ORIGIN_MAX = 255;
export const NOTES_MAX = 1000;

export interface Inventory {
  readonly id: string;
  readonly establishmentId: string;
  readonly name: string;
  /** YYYY-MM-DD */
  readonly startDate: string;
  /** YYYY-MM-DD */
  readonly endDate: string;
  readonly origin: string;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InventoryData {
  readonly establishmentId: string;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly origin: string;
  readonly notes: string | null;
}

export interface InventoryInput {
  establishmentId: string;
  name: string;
  startDate: string;
  endDate: string;
  origin: string;
  notes?: string | null;
}

export type InventoryChanges = Partial<InventoryInput>;

export const DATES_ORDER_MESSAGE = 'La fecha final no puede ser anterior a la fecha inicial';

/** Validates and normalizes only the provided fields. Throws a 400 listing every invalid field. */
export function normalizeInventoryChanges(input: InventoryChanges): Partial<InventoryData> {
  const issues: FieldIssue[] = [];
  const out: { -readonly [K in keyof InventoryData]?: InventoryData[K] } = {};
  if (input.establishmentId !== undefined) {
    out.establishmentId = validUuid(
      'establishmentId',
      'establecimiento',
      input.establishmentId,
      issues,
    );
  }
  if (input.name !== undefined) {
    out.name = requiredText('name', 'nombre', NAME_MAX, input.name, issues);
  }
  if (input.startDate !== undefined) {
    out.startDate = validDate('startDate', 'fecha inicial', input.startDate, issues);
  }
  if (input.endDate !== undefined) {
    out.endDate = validDate('endDate', 'fecha final', input.endDate, issues);
  }
  if (input.origin !== undefined) {
    out.origin = requiredText('origin', 'procedencia', ORIGIN_MAX, input.origin, issues);
  }
  if (input.notes !== undefined) {
    out.notes = optionalText('notes', 'observaciones', NOTES_MAX, input.notes, issues);
  }
  if (issues.length === 0) assertDatesOrder(out.startDate, out.endDate, issues);
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return out;
}

/** Adds an issue when both dates are known and the end is before the start (ISO dates sort as text). */
function assertDatesOrder(
  start: string | undefined,
  end: string | undefined,
  issues: FieldIssue[],
): void {
  if (start !== undefined && end !== undefined && end < start) {
    issues.push({ field: 'endDate', message: DATES_ORDER_MESSAGE });
  }
}

/** Validates the dates of an edit against the stored record (only one of them may be in `changes`). */
export function assertEditedDates(current: Inventory, changes: Partial<InventoryData>): void {
  const issues: FieldIssue[] = [];
  assertDatesOrder(
    changes.startDate ?? current.startDate,
    changes.endDate ?? current.endDate,
    issues,
  );
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
}

/** Validates and normalizes a complete inventory. */
export function normalizeNewInventory(input: InventoryInput): InventoryData {
  const data = normalizeInventoryChanges(input);
  return { notes: null, ...data } as InventoryData;
}

export function changedInventoryFields(
  current: Inventory,
  changes: Partial<InventoryData>,
): string[] {
  return (Object.keys(changes) as (keyof InventoryData)[]).filter(
    (key) => changes[key] !== current[key],
  );
}
