import { z } from 'zod';
import {
  ADDRESS_MAX,
  CITY_MAX,
  DEPARTMENT_MAX,
  NAME_MAX,
  PHONE_MAX,
  PHONE_PATTERN,
} from '../../domain/establishment/establishment.js';
import {
  CODE_MAX as CATEGORY_CODE_MAX,
  DESCRIPTION_MAX as CATEGORY_DESCRIPTION_MAX,
  NAME_MAX as CATEGORY_NAME_MAX,
} from '../../domain/category/category.js';
import {
  BRAND_MAX as PRODUCT_BRAND_MAX,
  DESCRIPTION_MAX as PRODUCT_DESCRIPTION_MAX,
  NAME_MAX as PRODUCT_NAME_MAX,
  SKU_MAX as PRODUCT_SKU_MAX,
} from '../../domain/product/product.js';
import {
  NAME_MAX as INVENTORY_NAME_MAX,
  NOTES_MAX as INVENTORY_NOTES_MAX,
  ORIGIN_MAX as INVENTORY_ORIGIN_MAX,
} from '../../domain/inventory/inventory.js';
import { BARCODE_MAX as LINE_BARCODE_MAX } from '../../domain/inventory-line/inventory-line.js';
import { PRICE_PATTERN, QUANTITY_PATTERN } from '../../domain/shared/decimal.js';
import { isValidDate } from '../../domain/shared/fields.js';

/** Text input must not carry NUL: PostgreSQL rejects it and it would surface as a 500. */
export const text = () =>
  z.string().refine((value) => !value.includes('\u0000'), {
    message: 'No puede contener el carácter nulo',
  });

/** UUIDs are accepted in any case and normalized to lowercase before reaching the use cases. */
export const idSchema = z.uuid().transform((value) => value.toLowerCase());

/** Text limits apply after trimming outer spaces, as the domain stores trimmed text. */
const phone = text()
  .trim()
  .max(PHONE_MAX)
  .refine((value) => value.trim() === '' || PHONE_PATTERN.test(value.trim()), {
    message: 'El teléfono solo admite dígitos, +, -, paréntesis y espacios',
  });

const fields = {
  name: text().trim().max(NAME_MAX),
  address: text().trim().max(ADDRESS_MAX),
  city: text().trim().max(CITY_MAX),
  department: text().trim().max(DEPARTMENT_MAX),
  latitude: z.number(),
  longitude: z.number(),
};

/** `id` is the optional client-generated identifier (offline creation). */
export const createEstablishmentSchema = z.object({
  ...fields,
  phone: phone.optional(),
  id: idSchema.optional(),
});

export const updateEstablishmentSchema = z
  .object({
    name: fields.name.optional(),
    address: fields.address.optional(),
    city: fields.city.optional(),
    department: fields.department.optional(),
    phone: phone.nullable().optional(),
    latitude: fields.latitude.optional(),
    longitude: fields.longitude.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const establishmentStatusSchema = z.object({ isActive: z.boolean() });

export const listEstablishmentsQuerySchema = z.object({
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  q: text().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listChangesQuerySchema = z.object({
  cursor: text().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// ---- Catalog and inventories (sprint 005) ----

const statusQuery = z.enum(['active', 'inactive', 'all']).default('all');
const limitQuery = z.coerce.number().int().min(1).max(200).default(50);
const offsetQuery = z.coerce.number().int().min(0).default(0);

/** `limit`/`offset` of the paginated read-only histories. */
export const pageQuerySchema = z.object({ limit: limitQuery, offset: offsetQuery });

/** Decimals travel as text (ADR-0003): JSON numbers, negatives and exponents are rejected. */
const price = z.string().regex(PRICE_PATTERN);
const quantity = z.string().regex(QUANTITY_PATTERN);
const date = z.string().refine(isValidDate, { message: 'Debe ser una fecha válida (AAAA-MM-DD)' });
/** The current quantity is calculated by the server: sending it is a 400. */
const forbiddenQuantityCurrent = z.never().optional();

const categoryFields = {
  code: text().trim().max(CATEGORY_CODE_MAX),
  name: text().trim().max(CATEGORY_NAME_MAX),
  description: text().trim().max(CATEGORY_DESCRIPTION_MAX),
};

export const createCategorySchema = z.object({
  ...categoryFields,
  description: categoryFields.description.nullable().optional(),
  id: idSchema.optional(),
});

export const updateCategorySchema = z
  .object({
    code: categoryFields.code.optional(),
    name: categoryFields.name.optional(),
    description: categoryFields.description.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const listCategoriesQuerySchema = z.object({
  status: statusQuery,
  q: text().max(100).optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const productFields = {
  sku: text().trim().max(PRODUCT_SKU_MAX),
  name: text().trim().max(PRODUCT_NAME_MAX),
  description: text().trim().max(PRODUCT_DESCRIPTION_MAX).nullable().optional(),
  brand: text().trim().max(PRODUCT_BRAND_MAX).nullable().optional(),
  unit: text(),
  categoryId: idSchema,
  price,
};

export const createProductSchema = z.object({ ...productFields, id: idSchema.optional() });

export const updateProductSchema = z
  .object({
    sku: productFields.sku.optional(),
    name: productFields.name.optional(),
    description: productFields.description,
    brand: productFields.brand,
    unit: productFields.unit.optional(),
    categoryId: productFields.categoryId.optional(),
    price: productFields.price.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const listProductsQuerySchema = z.object({
  status: statusQuery,
  q: text().max(100).optional(),
  categoryId: idSchema.optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const inventoryFields = {
  establishmentId: idSchema,
  name: text().trim().max(INVENTORY_NAME_MAX),
  startDate: date,
  endDate: date,
  origin: text().trim().max(INVENTORY_ORIGIN_MAX),
  notes: text().trim().max(INVENTORY_NOTES_MAX).nullable().optional(),
};

export const createInventorySchema = z.object({ ...inventoryFields, id: idSchema.optional() });

export const updateInventorySchema = z
  .object({
    establishmentId: inventoryFields.establishmentId.optional(),
    name: inventoryFields.name.optional(),
    startDate: inventoryFields.startDate.optional(),
    endDate: inventoryFields.endDate.optional(),
    origin: inventoryFields.origin.optional(),
    notes: inventoryFields.notes,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const listInventoriesQuerySchema = z.object({
  status: statusQuery,
  q: text().max(100).optional(),
  establishmentId: idSchema.optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const lineBarcode = text().trim().max(LINE_BARCODE_MAX);

export const createInventoryLineSchema = z.object({
  id: idSchema.optional(),
  productId: idSchema,
  barcode: lineBarcode,
  expiresOn: date.nullable().optional(),
  quantityInitial: quantity,
  quantityAlert: quantity,
  quantityCurrent: forbiddenQuantityCurrent,
});

export const updateInventoryLineSchema = z
  .object({
    barcode: lineBarcode.optional(),
    expiresOn: date.nullable().optional(),
    quantityInitial: quantity.optional(),
    quantityAlert: quantity.optional(),
    quantityCurrent: forbiddenQuantityCurrent,
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const listInventoryLinesQuerySchema = z.object({
  status: statusQuery,
  productId: idSchema.optional(),
  barcode: text().max(LINE_BARCODE_MAX).optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

// ---- Users by establishment and stock search (sprint 006) ----

export const assignmentPageQuerySchema = z.object({
  includeRemoved: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  limit: limitQuery,
  offset: offsetQuery,
});

export const userAssignmentsQuerySchema = z.object({
  userId: idSchema,
  includeRemoved: assignmentPageQuerySchema.shape.includeRemoved,
  limit: limitQuery,
  offset: offsetQuery,
});

/** Exactly one criterion: `barcode` (exact) or `q` (name or SKU); text limits apply after trimming. */
export const stockSearchQuerySchema = z
  .object({
    establishmentId: idSchema,
    barcode: text().trim().min(1).max(LINE_BARCODE_MAX).optional(),
    q: text().trim().min(1).max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: offsetQuery,
  })
  .refine((v) => (v.barcode === undefined) !== (v.q === undefined), {
    message: 'Indica exactamente un criterio: barcode o q',
  });

// ---- Carts (sprint 007) ----

/** `id` is the optional client-generated identifier (offline creation). */
export const createCartSchema = z.object({ id: idSchema.optional(), establishmentId: idSchema });

/** The only transition is to `cancelled`. */
export const cartStatusSchema = z.object({ status: z.literal('cancelled') });

export const listCartsQuerySchema = z.object({
  status: z.enum(['open', 'cancelled']).optional(),
  establishmentId: idSchema.optional(),
  userId: idSchema.optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

/** The quantity is exact decimal text (ADR-0003); `> 0` is checked by the domain. */
export const addCartItemSchema = z.object({
  id: idSchema.optional(),
  inventoryLineId: idSchema,
  quantity,
});

export const updateCartItemSchema = z.object({ quantity });
