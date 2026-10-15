import express from 'express';
import { createAuctionController } from '../controllers/auctionController.js';
import { validate } from '../middleware/validate.js';
import {
  createAuctionSchema,
  listAuctionsQuerySchema,
  auctionIdParamSchema,
  placeBidSchema,
  bidHistoryQuerySchema,
} from '../validators/auctionValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * Builds the /api/auctions router.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createAuctionRouter({ db }) {
  const router = express.Router();
  const auctions = createAuctionController({ db });

  // GET /api/auctions
  router.get('/', validate(listAuctionsQuerySchema, 'query'), auctions.listAuctions);

  // GET /api/auctions/:id
  router.get('/:id', validate(auctionIdParamSchema, 'params'), auctions.getAuctionById);

  // GET /api/auctions/:id/bids
  router.get(
    '/:id/bids',
    validate(auctionIdParamSchema, 'params'),
    validate(bidHistoryQuerySchema, 'query'),
    auctions.getBidHistory
  );

  // POST /api/auctions
  router.post('/', requireAuth, validate(createAuctionSchema), auctions.createAuction);

  // POST /api/auctions/:id/bids
  router.post(
    '/:id/bids',
    requireAuth,
    validate(auctionIdParamSchema, 'params'),
    validate(placeBidSchema, 'body'),
    auctions.placeBid
  );

  return router;
}

export default createAuctionRouter;
