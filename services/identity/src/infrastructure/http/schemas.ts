import { z } from 'zod';
import { ROLE_NAME_MAX } from '../../domain/role/role-rules.js';
import { FULL_NAME_MAX } from '../../domain/user/user.js';

/**
 * Text input must not carry NUL: PostgreSQL rejects it and it would surface as a 500. Replicated
 * from core (shared does not depend on zod and identity/core keep their HTTP layers independent).
 */
export const text = () =>
  z.string().refine((value) => !value.includes('\u0000'), {
    message: 'No puede contener el carácter nulo',
  });

/** UUIDs are canonicalised to lowercase so identity comparisons cannot be bypassed by case. */
export const idSchema = z.uuid().transform((value) => value.toLowerCase());

export const loginSchema = z.object({ email: text().max(254), password: text().max(256) });
export const refreshSchema = z.object({ refreshToken: text().min(1).max(512) });
export const changePasswordSchema = z.object({
  currentPassword: text().max(256),
  newPassword: text().max(256),
});
export const resetPasswordSchema = z.object({ newPassword: text().max(256) });

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createUserSchema = z.object({
  email: text().max(254),
  password: text().max(256),
  fullName: text().max(FULL_NAME_MAX),
  roleId: idSchema,
});

export const updateUserSchema = z
  .object({
    email: text().max(254).optional(),
    fullName: text().max(FULL_NAME_MAX).optional(),
    roleId: idSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const userStatusSchema = z.object({ isActive: z.boolean() });

export const createRoleSchema = z.object({
  name: text().max(ROLE_NAME_MAX),
  description: text().max(1000).optional(),
});
export const updateRoleSchema = z
  .object({
    name: text().max(ROLE_NAME_MAX).optional(),
    description: text().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });
export const rolePermissionsSchema = z.object({
  permissions: z.array(text().max(100)).max(500),
});
