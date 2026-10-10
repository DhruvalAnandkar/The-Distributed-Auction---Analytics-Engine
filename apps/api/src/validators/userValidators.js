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
