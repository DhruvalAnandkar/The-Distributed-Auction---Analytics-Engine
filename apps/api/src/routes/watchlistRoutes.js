import express from 'express';
import { createWatchlistController } from '../controllers/watchlistController.js';
import { validate } from '../middleware/validate.js';
import { watchlistAuctionIdParamSchema } from '../validators/watchlistValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * Builds the /api/watchlist router.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createWatchlistRouter({ db }) {
  const router = express.Router();
  const watchlist = createWatchlistController({ db });

  // GET /api/watchlist
  router.get('/', requireAuth, watchlist.getWatchlist);

  // POST /api/watchlist/:auctionId
  router.post(
    '/:auctionId',
    requireAuth,
    validate(watchlistAuctionIdParamSchema, 'params'),
    watchlist.addToWatchlist
  );

  // DELETE /api/watchlist/:auctionId
  router.delete(
    '/:auctionId',
    requireAuth,
    validate(watchlistAuctionIdParamSchema, 'params'),
    watchlist.removeFromWatchlist
  );

  return router;
}

export default createWatchlistRouter;
