import { z } from 'zod';

/**
 * Zod schema for validating notifications query parameters.
 */
export const notificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.coerce.number().int().positive().optional(),
  unreadOnly: z
    .union([z.boolean(), z.string().transform((val) => val === 'true')])
    .optional(),
});

/**
 * Zod schema for validating notification id parameter.
 */
export const notificationIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});
