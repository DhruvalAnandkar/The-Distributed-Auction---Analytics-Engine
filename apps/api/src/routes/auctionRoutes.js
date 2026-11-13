import express from 'express';
import { createAuctionController } from '../controllers/auctionController.js';
import { validate } from '../middleware/validate.js';
import {
  createAuctionSchema,
  updateAuctionSchema,
  listAuctionsQuerySchema,
  auctionIdParamSchema,
  placeBidSchema,
  bidHistoryQuerySchema,
} from '../validators/auctionValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { createIdempotencyMiddleware } from '../middleware/idempotency.js';

/**
 * Builds the /api/auctions router.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 * @param {Object} [deps.cache] - LRU cache instance.
 * @param {import('node:events').EventEmitter} [deps.eventBus] - Event bus instance.
 * @param {number} [deps.pingIntervalMs] - Ping interval in milliseconds for SSE.
 * @returns {import('express').Router}
 */
export function createAuctionRouter({ db, cache, eventBus, pingIntervalMs }) {
  const router = express.Router();
  const auctions = createAuctionController({ db, cache, eventBus, pingIntervalMs });
  const idempotency = createIdempotencyMiddleware({ db });

  const bidRateLimiter = createRateLimiter({
    capacity: 10,
    refillPerSecond: 2, // 2 tokens per second
    key: (req) => String(req.user?.id || 'anonymous'),
  });

  // GET /api/auctions
  router.get('/', validate(listAuctionsQuerySchema, 'query'), auctions.listAuctions);

  // GET /api/auctions/:id/events
  router.get(
    '/:id/events',
    validate(auctionIdParamSchema, 'params'),
    auctions.streamAuctionEvents
  );

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
  router.post(
    '/',
    requireAuth,
    idempotency,
    validate(createAuctionSchema),
    auctions.createAuction
  );

  // PATCH /api/auctions/:id
  router.patch(
    '/:id',
    requireAuth,
    validate(auctionIdParamSchema, 'params'),
    validate(updateAuctionSchema),
    auctions.updateAuction
  );

  // POST /api/auctions/:id/bids
  router.post(
    '/:id/bids',
    requireAuth,
    bidRateLimiter,
    idempotency,
    validate(auctionIdParamSchema, 'params'),
    validate(placeBidSchema, 'body'),
    auctions.placeBid
  );

  return router;
}

export default createAuctionRouter;
