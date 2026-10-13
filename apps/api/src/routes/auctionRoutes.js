import express from 'express';
import { createAuctionController } from '../controllers/auctionController.js';
import { validate } from '../middleware/validate.js';
import { createAuctionSchema } from '../validators/auctionValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * Builds the /api/auctions router.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createAuctionRouter({ db }) {
  const router = express.Router();
  const auctions = createAuctionController({ db });

  // POST /api/auctions
  router.post('/', requireAuth, validate(createAuctionSchema), auctions.createAuction);

  return router;
}

export default createAuctionRouter;
