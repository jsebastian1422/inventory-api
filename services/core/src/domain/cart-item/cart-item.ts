import { MAX_QUANTITY_UNITS, QUANTITY_SCALE, toUnits } from '../shared/decimal.js';
import { DomainError, validationError, type FieldIssue } from '../shared/errors.js';
import { validQuantity } from '../shared/fields.js';

export interface CartItem {
  readonly id: string;
  readonly cartId: string;
  readonly inventoryLineId: string;
  /** Exact decimal text with 3 decimals (ADR-0003). */
  readonly quantity: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewCartItem {
  readonly inventoryLineId: string;
  readonly quantity: string;
}

/** Validates a quantity of a cart item (decimal text, > 0, within numeric(14,3)) and normalizes it. */
export function positiveQuantity(value: unknown): string {
  const issues: FieldIssue[] = [];
  const quantity = validQuantity('quantity', 'cantidad', value, issues);
  if (issues.length === 0 && toUnits(quantity, QUANTITY_SCALE) <= 0n) {
    issues.push({ field: 'quantity', message: 'El campo cantidad debe ser mayor que cero' });
  }
  if (issues.length === 0 && toUnits(quantity, QUANTITY_SCALE) > MAX_QUANTITY_UNITS) {
    issues.push({ field: 'quantity', message: 'El campo cantidad excede el máximo' });
  }
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return quantity;
}

export const cartItemNotFoundError = (): DomainError =>
  new DomainError('not_found', 'Ítem de carrito no encontrado', 'CART_ITEM_NOT_FOUND');
