import { z } from 'zod';
import { ROLE_NAME_MAX } from '../../domain/role/role-rules.js';
import { FULL_NAME_MAX } from '../../domain/user/user.js';

export const idSchema = z.uuid();

export const loginSchema = z.object({ email: z.string().max(254), password: z.string().max(256) });
export const refreshSchema = z.object({ refreshToken: z.string().min(1).max(512) });
export const changePasswordSchema = z.object({
  currentPassword: z.string().max(256),
  newPassword: z.string().max(256),
});
export const resetPasswordSchema = z.object({ newPassword: z.string().max(256) });

export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createUserSchema = z.object({
  email: z.string().max(254),
  password: z.string().max(256),
  fullName: z.string().max(FULL_NAME_MAX),
  roleId: z.uuid(),
});

export const updateUserSchema = z
  .object({
    email: z.string().max(254).optional(),
    fullName: z.string().max(FULL_NAME_MAX).optional(),
    roleId: z.uuid().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });

export const userStatusSchema = z.object({ isActive: z.boolean() });

export const createRoleSchema = z.object({
  name: z.string().max(ROLE_NAME_MAX),
  description: z.string().max(1000).optional(),
});
export const updateRoleSchema = z
  .object({
    name: z.string().max(ROLE_NAME_MAX).optional(),
    description: z.string().max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Indica al menos un campo a modificar' });
export const rolePermissionsSchema = z.object({
  permissions: z.array(z.string().max(100)).max(500),
});
