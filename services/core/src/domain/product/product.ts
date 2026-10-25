import { PRICE_SCALE, compareDecimal } from '../shared/decimal.js';
import { validationError, type FieldIssue } from '../shared/errors.js';
import { optionalText, requiredText, validPrice, validUuid } from '../shared/fields.js';

export const SKU_MAX = 50;
export const NAME_MAX = 150;
export const DESCRIPTION_MAX = 1000;
export const BRAND_MAX = 100;

export const UNITS = ['unit', 'meter', 'kilogram', 'liter', 'box', 'package'] as const;
export type ProductUnit = (typeof UNITS)[number];

export interface Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly brand: string | null;
  readonly unit: ProductUnit;
  readonly categoryId: string;
  /** Exact decimal text with 2 decimals (ADR-0003). */
  readonly price: string;
  readonly isActive: boolean;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ProductData {
  readonly sku: string;
  readonly name: string;
  readonly description: string | null;
  readonly brand: string | null;
  readonly unit: ProductUnit;
  readonly categoryId: string;
  readonly price: string;
}

export interface ProductInput {
  sku: string;
  name: string;
  description?: string | null;
  brand?: string | null;
  unit: string;
  categoryId: string;
  price: string;
}

export type ProductChanges = Partial<ProductInput>;

/** One row of the price history (read only). `oldPrice` is null for the initial price. */
export interface PriceChange {
  readonly id: string;
  readonly oldPrice: string | null;
  readonly newPrice: string;
  readonly actorId: string;
  readonly changedAt: Date;
}

/** Validates and normalizes only the provided fields. Throws a 400 listing every invalid field. */
export function normalizeProductChanges(input: ProductChanges): Partial<ProductData> {
  const issues: FieldIssue[] = [];
  const out: { -readonly [K in keyof ProductData]?: ProductData[K] } = {};
  if (input.sku !== undefined) {
    out.sku = requiredText('sku', 'SKU', SKU_MAX, input.sku, issues).toUpperCase();
  }
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
  if (input.brand !== undefined) {
    out.brand = optionalText('brand', 'marca', BRAND_MAX, input.brand, issues);
  }
  if (input.unit !== undefined) {
    if ((UNITS as readonly string[]).includes(input.unit)) out.unit = input.unit as ProductUnit;
    else {
      issues.push({ field: 'unit', message: `La unidad debe ser una de: ${UNITS.join(', ')}` });
    }
  }
  if (input.categoryId !== undefined) {
    out.categoryId = validUuid('categoryId', 'categoría', input.categoryId, issues);
  }
  if (input.price !== undefined) out.price = validPrice('price', 'precio', input.price, issues);
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return out;
}

/** Validates and normalizes a complete product. */
export function normalizeNewProduct(input: ProductInput): ProductData {
  const data = normalizeProductChanges(input);
  return { description: null, brand: null, ...data } as ProductData;
}

/** True when the price in `changes` differs from the current one (exact comparison). */
export function priceChanged(current: Product, changes: Partial<ProductData>): boolean {
  return (
    changes.price !== undefined && compareDecimal(changes.price, current.price, PRICE_SCALE) !== 0
  );
}

/** Names of the fields in `changes` whose value differs from the current record. */
export function changedProductFields(current: Product, changes: Partial<ProductData>): string[] {
  return (Object.keys(changes) as (keyof ProductData)[]).filter((key) =>
    key === 'price' ? priceChanged(current, changes) : changes[key] !== current[key],
  );
}
