import { z } from 'zod';

/**
 * Zod schema for validating admin user listing query parameters.
 */
export const listUsersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.coerce.number().int().positive().optional(),
  role: z.enum(['user', 'admin']).optional(),
});
