import express from 'express';
import { createAuctionController } from '../controllers/auctionController.js';
import { validate } from '../middleware/validate.js';
import {
  createAuctionSchema,
  listAuctionsQuerySchema,
  auctionIdParamSchema,
} from '../validators/auctionValidators.js';
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

  // GET /api/auctions
  router.get('/', validate(listAuctionsQuerySchema, 'query'), auctions.listAuctions);

  // GET /api/auctions/:id
  router.get('/:id', validate(auctionIdParamSchema, 'params'), auctions.getAuctionById);

  // POST /api/auctions
  router.post('/', requireAuth, validate(createAuctionSchema), auctions.createAuction);

  return router;
}

export default createAuctionRouter;
