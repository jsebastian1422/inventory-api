import { PHONE_MAX, PHONE_PATTERN } from '../establishment/establishment.js';
import { hasFullAccess, type Actor } from '../scope/scope.js';
import { DomainError, validationError, type FieldIssue } from '../shared/errors.js';

export const PERM_SALE_CREATE = 'sales.create';
export const PERM_SALE_READ = 'sales.read';

export const DOC_TYPES = ['CC', 'CE', 'NIT', 'PAS', 'TI'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_NUMBER_MAX = 20;
export const CUSTOMER_NAME_MAX = 150;
export const EMAIL_MAX = 254;

/** Label of a sale without buyer data (R-7). */
export const FINAL_CONSUMER = 'Consumidor final';

/** Buyer of a sale (R-7): document type, number and name travel together; email and phone are optional. */
export interface Customer {
  readonly docType: DocType;
  readonly docNumber: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
}

/** Why an active item of a cart cannot be sold now (R-3). */
export type SaleUnavailableReason =
  | 'LINE_INACTIVE'
  | 'INVENTORY_INACTIVE'
  | 'PRODUCT_INACTIVE'
  | 'LINE_OTHER_ESTABLISHMENT'
  | 'INSUFFICIENT_STOCK';

/** Item sold, with the data of product and lot as they were at the sale (R-5). Amounts as text. */
export interface SaleItem {
  readonly id: string;
  readonly cartItemId: string;
  readonly inventoryLineId: string;
  readonly productId: string;
  readonly sku: string;
  readonly productName: string;
  readonly unit: string;
  readonly barcode: string;
  readonly expiresOn: string | null;
  /** Exact decimal text with 2 decimals (ADR-0003). */
  readonly unitPrice: string;
  /** Exact decimal text with 3 decimals. */
  readonly quantity: string;
  /** round(quantity x unitPrice, 2), calculated in SQL. */
  readonly subtotal: string;
}

/** Internal invoice of a sale; immutable (R-8). `number` is consecutive per establishment (ADR-0005). */
export interface Sale {
  readonly id: string;
  readonly number: number;
  readonly establishmentId: string;
  readonly cartId: string;
  readonly sellerId: string;
  readonly customer: Customer | null;
  readonly items: SaleItem[];
  readonly total: string;
  readonly createdAt: Date;
  readonly version: number;
}

export const saleNotFoundError = (): DomainError =>
  new DomainError('not_found', 'Venta no encontrada', 'SALE_NOT_FOUND');

/** "Consumidor final" without buyer, otherwise the buyer's name. */
export const customerLabel = (sale: Pick<Sale, 'customer'>): string =>
  sale.customer?.name ?? FINAL_CONSUMER;

/** True when the sale was made by the actor (ids compared case-insensitively). */
export const isSeller = (sale: Pick<Sale, 'sellerId'>, actor: Actor): boolean =>
  sale.sellerId.toLowerCase() === actor.userId.toLowerCase();

export const canSell = (actor: Actor): boolean => actor.permissions.includes(PERM_SALE_CREATE);

export const canReadSales = (actor: Actor): boolean => actor.permissions.includes(PERM_SALE_READ);

/** A user with `sales.read` and `establishments.all` reads the sales of any establishment. */
export const readsAllSales = (actor: Actor): boolean => canReadSales(actor) && hasFullAccess(actor);

const DOC_NUMBER_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Raw buyer input as received; every field is validated by `normalizeCustomer`. */
export interface CustomerInput {
  docType?: unknown;
  docNumber?: unknown;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}

function required(field: string, label: string, value: unknown, max: number, issues: FieldIssue[]) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length === 0) issues.push({ field, message: `El campo ${label} es obligatorio` });
  else if (text.length > max) {
    issues.push({ field, message: `El campo ${label} admite máximo ${max} caracteres` });
  }
  return text;
}

function optional(field: string, label: string, value: unknown, max: number, issues: FieldIssue[]) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    issues.push({ field, message: `El campo ${label} debe ser texto` });
    return null;
  }
  const text = value.trim();
  if (text.length === 0) return null;
  if (text.length > max) {
    issues.push({ field, message: `El campo ${label} admite máximo ${max} caracteres` });
  }
  return text;
}

/**
 * Validates and normalizes the buyer (R-7). No buyer (`undefined`/`null`) is "Consumidor final".
 * Throws a 400 listing every invalid field.
 */
export function normalizeCustomer(input: CustomerInput | null | undefined): Customer | null {
  if (input === undefined || input === null) return null;
  const issues: FieldIssue[] = [];
  const docType = required('customer.docType', 'tipo de documento', input.docType, 4, issues);
  if (docType.length > 0 && !(DOC_TYPES as readonly string[]).includes(docType)) {
    issues.push({
      field: 'customer.docType',
      message: `El tipo de documento debe ser uno de: ${DOC_TYPES.join(', ')}`,
    });
  }
  const docNumber = required(
    'customer.docNumber',
    'número de documento',
    input.docNumber,
    DOC_NUMBER_MAX,
    issues,
  );
  if (docNumber.length > 0 && !DOC_NUMBER_PATTERN.test(docNumber)) {
    issues.push({
      field: 'customer.docNumber',
      message: 'El número de documento solo admite letras, dígitos y guion entre caracteres alfanuméricos',
    });
  }
  const name = required('customer.name', 'nombre', input.name, CUSTOMER_NAME_MAX, issues);
  const email = optional('customer.email', 'correo', input.email, EMAIL_MAX, issues);
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    issues.push({ field: 'customer.email', message: 'El correo no es válido' });
  }
  const phone = optional('customer.phone', 'teléfono', input.phone, PHONE_MAX, issues);
  if (phone !== null && !PHONE_PATTERN.test(phone)) {
    issues.push({
      field: 'customer.phone',
      message: 'El teléfono solo admite dígitos, +, -, paréntesis y espacios',
    });
  }
  if (issues.length > 0) throw validationError('Datos inválidos', issues);
  return { docType: docType as DocType, docNumber, name, email, phone };
}
