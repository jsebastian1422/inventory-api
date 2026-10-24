import { z } from 'zod';
import {
  ADDRESS_MAX,
  CITY_MAX,
  DEPARTMENT_MAX,
  NAME_MAX,
  PHONE_MAX,
  PHONE_PATTERN,
} from '../../domain/establishment/establishment.js';

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

export const createEstablishmentSchema = z.object({ ...fields, phone: phone.optional() });

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
