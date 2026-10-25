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

export const idSchema = z.uuid();

/** Text limits apply after trimming outer spaces, as the domain stores trimmed text. */
const phone = z
  .string()
  .trim()
  .max(PHONE_MAX)
  .refine((value) => value.trim() === '' || PHONE_PATTERN.test(value.trim()), {
    message: 'El teléfono solo admite dígitos, +, -, paréntesis y espacios',
  });

const fields = {
  name: z.string().trim().max(NAME_MAX),
  address: z.string().trim().max(ADDRESS_MAX),
  city: z.string().trim().max(CITY_MAX),
  department: z.string().trim().max(DEPARTMENT_MAX),
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
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const listChangesQuerySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
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
  code: z.string().trim().max(CATEGORY_CODE_MAX),
  name: z.string().trim().max(CATEGORY_NAME_MAX),
  description: z.string().trim().max(CATEGORY_DESCRIPTION_MAX),
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
  q: z.string().max(100).optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const productFields = {
  sku: z.string().trim().max(PRODUCT_SKU_MAX),
  name: z.string().trim().max(PRODUCT_NAME_MAX),
  description: z.string().trim().max(PRODUCT_DESCRIPTION_MAX).nullable().optional(),
  brand: z.string().trim().max(PRODUCT_BRAND_MAX).nullable().optional(),
  unit: z.string(),
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
  q: z.string().max(100).optional(),
  categoryId: idSchema.optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const inventoryFields = {
  establishmentId: idSchema,
  name: z.string().trim().max(INVENTORY_NAME_MAX),
  startDate: date,
  endDate: date,
  origin: z.string().trim().max(INVENTORY_ORIGIN_MAX),
  notes: z.string().trim().max(INVENTORY_NOTES_MAX).nullable().optional(),
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
  q: z.string().max(100).optional(),
  establishmentId: idSchema.optional(),
  limit: limitQuery,
  offset: offsetQuery,
});

const lineBarcode = z.string().trim().max(LINE_BARCODE_MAX);

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
  barcode: z.string().max(LINE_BARCODE_MAX).optional(),
  limit: limitQuery,
  offset: offsetQuery,
});
