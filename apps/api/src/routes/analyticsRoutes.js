import express from 'express';
import { createAnalyticsController } from '../controllers/analyticsController.js';
import { validate } from '../middleware/validate.js';
import { topAuctionsQuerySchema } from '../validators/analyticsValidators.js';

/**
 * Builds the /api/analytics router.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createAnalyticsRouter({ db }) {
  const router = express.Router();
  const analytics = createAnalyticsController({ db });

  // GET /api/analytics/top-auctions
  router.get(
    '/top-auctions',
    validate(topAuctionsQuerySchema, 'query'),
    analytics.getTopAuctions
  );

  return router;
}

export default createAnalyticsRouter;
