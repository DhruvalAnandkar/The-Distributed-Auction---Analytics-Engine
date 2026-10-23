import { z } from 'zod';

/**
 * Zod schema for validating query parameters for the top-auctions analytics endpoint.
 */
export const topAuctionsQuerySchema = z.object({
  window: z.enum(['24h', '7d', '30d']).default('7d'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
