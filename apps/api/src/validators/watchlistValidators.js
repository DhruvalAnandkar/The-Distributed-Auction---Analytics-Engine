import { z } from 'zod';

/**
 * Zod schema for validating auctionId route parameter in watchlist routes.
 */
export const watchlistAuctionIdParamSchema = z.object({
  auctionId: z.coerce.number().int().positive(),
});
