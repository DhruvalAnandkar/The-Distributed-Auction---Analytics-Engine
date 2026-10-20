import { z } from 'zod';

/**
 * Zod schema for validating user registration payloads.
 */
export const registerSchema = z.object({
  username: z
    .string({ required_error: 'Username is required' })
    .min(3, 'Username must be between 3 and 50 characters')
    .max(50, 'Username must be between 3 and 50 characters')
    .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores'),
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .toLowerCase(),
  password: z
    .string({ required_error: 'Password is required' })
    .min(8, 'Password must be between 8 and 128 characters')
    .max(128, 'Password must be between 8 and 128 characters')
    .refine((val) => /[a-zA-Z]/.test(val) && /[0-9]/.test(val), {
      message: 'Password must contain at least one letter and one number',
    }),
});

/**
 * Zod schema for validating user login payloads.
 */
export const loginSchema = z.object({
  email: z
    .string({ required_error: 'Email is required' })
    .email('Invalid email address')
    .toLowerCase(),
  password: z
    .string({ required_error: 'Password is required' })
    .min(1, 'Password is required'),
});

/**
 * Zod schema for validating user id route parameter.
 */
export const userIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

/**
 * Zod schema for validating user profile update payloads.
 * Requires at least one of username or email to be provided.
 */
export const updateProfileSchema = z
  .object({
    username: z
      .string()
      .min(3, 'Username must be between 3 and 50 characters')
      .max(50, 'Username must be between 3 and 50 characters')
      .regex(/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores')
      .optional(),
    email: z
      .string()
      .email('Invalid email address')
      .toLowerCase()
      .optional(),
  })
  .refine((data) => data.username !== undefined || data.email !== undefined, {
    message: 'At least one field (username or email) must be provided',
  });

/**
 * Zod schema for validating user change password payloads.
 */
export const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ required_error: 'Current password is required' })
      .min(1, 'Current password is required'),
    newPassword: z
      .string({ required_error: 'New password is required' })
      .min(8, 'Password must be between 8 and 128 characters')
      .max(128, 'Password must be between 8 and 128 characters')
      .refine((val) => /[a-zA-Z]/.test(val) && /[0-9]/.test(val), {
        message: 'Password must contain at least one letter and one number',
      }),
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    message: 'New password must be different from current password',
    path: ['newPassword'],
  });
