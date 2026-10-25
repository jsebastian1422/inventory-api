import { QUANTITY_SCALE, compareDecimal } from '../shared/decimal.js';
import { validationError, type FieldIssue } from '../shared/errors.js';
import { requiredText, validDate, validQuantity, validUuid } from '../shared/fields.js';

export const BARCODE_MAX = 64;

export interface InventoryLine {
  readonly id: string;
  readonly inventoryId: string;
  readonly productId: string;
  readonly barcode: string;
  /** YYYY-MM-DD or null. */
  readonly expiresOn: string | null;
  /** Exact decimal text with 3 decimals (ADR-0003). */
  readonly quantityInitial: string;
  readonly quantityAlert: string;
  readonly quantityCurrent: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Editable data of a line. `quantityCurrent` is calculated by the server, never received. */
export interface InventoryLineData {
  readonly barcode: string;
  readonly expiresOn: string | null;
  readonly quantityInitial: string;
  readonly quantityAlert: string;
}

export interface InventoryLineInput {
  productId: string;
  barcode: string;
  expiresOn?: string | null;
  quantityInitial: string;
  quantityAlert: string;
}

/** Raw input of an edit (the product of a line cannot change); `expiresOn: null` clears it. */
export type InventoryLineChanges = Partial<Omit<InventoryLineInput, 'productId'>>;

/** Data to create a line: the product is fixed at creation. */
export interface NewInventoryLine extends InventoryLineData {
  readonly productId: string;
}

export type LineHistoryReason = 'created' | 'initial_adjusted';

/** One row of the quantity history (read only). `*Before` is null on `created`. */
export interface LineHistoryEntry {
  readonly id: string;
  readonly reason: LineHistoryReason;
  readonly initialBefore: string | null;
  readonly initialAfter: string;
  readonly currentBefore: string | null;
  readonly currentAfter: string;
  readonly delta: string | null;
  readonly actorId: string;
  readonly changedAt: Date;
}

function normalizeExpiry(value: string | null, issues: FieldIssue[]): string | null {
  const text = value?.trim() ?? '';
  return text.length === 0 ? null : validDate('expiresOn', 'vencimiento', text, issues);
}

/** Validates and normalizes only the provided fields. Throws a 400 listing every invalid field. */
export function normalizeLineChanges(input: InventoryLineChanges): Partial<InventoryLineData> {
  const issues: FieldIssue[] = [];
  const out: { -readonly [K in keyof InventoryLineData]?: InventoryLineData[K] } = {};
  if (input.barcode !== undefined) {
    out.barcode = requiredText('barcode', 'código de barras', BARCODE_MAX, input.barcode, issues);
  }
  if (input.expiresOn !== undefined) out.expiresOn = normalizeExpiry(input.expiresOn, issues);
  if (input.quantityInitial !== undefined) {
    out.quantityInitial = validQuantity(
      'quantityInitial',
      'cantidad inicial',
      input.quantityInitial,
      issues,
    );
  }
  if (input.quantityAlert !== undefined) {
    out.quantityAlert = validQuantity(
      'quantityAlert',
      'cantidad de alerta',
      input.quantityAlert,
      issues,
    );
  }
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return out;
}

/** Validates and normalizes a complete line (all required fields must be present). */
export function normalizeNewLine(input: InventoryLineInput): NewInventoryLine {
  const issues: FieldIssue[] = [];
  const productId = validUuid('productId', 'producto', input.productId, issues);
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  const data = normalizeLineChanges(input);
  return { expiresOn: null, ...data, productId } as NewInventoryLine;
}

/** True when the initial quantity in `changes` differs from the current one (exact comparison). */
export function initialChanged(
  current: InventoryLine,
  changes: Partial<InventoryLineData>,
): boolean {
  return (
    changes.quantityInitial !== undefined &&
    compareDecimal(changes.quantityInitial, current.quantityInitial, QUANTITY_SCALE) !== 0
  );
}

export function changedLineFields(
  current: InventoryLine,
  changes: Partial<InventoryLineData>,
): string[] {
  return (Object.keys(changes) as (keyof InventoryLineData)[]).filter((key) =>
    key === 'quantityInitial' ? initialChanged(current, changes) : changes[key] !== current[key],
  );
}
