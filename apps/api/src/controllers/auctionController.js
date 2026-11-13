import crypto from 'node:crypto';
import AppError from '../utils/AppError.js';
import { escapeLike } from '../utils/escapeLike.js';
import defaultEventBus from '../services/eventBus.js';

/**
 * @typedef {Object} AuctionCreationPayload
 * @property {string} title - Auction title.
 * @property {string} [description] - Optional auction description.
 * @property {number} startPrice - Starting price (> 0).
 * @property {string} endsAt - ISO date string at least 1 min in the future.
 */

/**
 * @typedef {Object} AuctionUpdatePayload
 * @property {string} [title] - Updated auction title.
 * @property {string | null} [description] - Updated auction description.
 * @property {string} [endsAt] - Updated auction ends at ISO date.
 */

/**
 * Builds the auction controller with its dependencies injected.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 * @param {Object} [deps.cache] - LRU cache instance for auction reads.
 * @param {import('node:events').EventEmitter} [deps.eventBus] - Event bus for real-time events.
 * @param {number} [deps.pingIntervalMs=25000] - Ping interval in milliseconds for SSE.
 */
export function createAuctionController({
  db,
  cache,
  eventBus = defaultEventBus,
  pingIntervalMs = 25000,
}) {
  /**
   * POST /api/auctions
   * Creates a new auction associated with the authenticated user.
   *
   * @param {import('express').Request<{}, {}, AuctionCreationPayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const createAuction = async (req, res, next) => {
    const { title, description, startPrice, endsAt } = req.body;
    const sellerId = req.user.id;

    try {
      const result = await db.query(
        `INSERT INTO auctions (
          title,
          description,
          start_price,
          current_price,
          status,
          seller_id,
          ends_at
        ) VALUES ($1, $2, $3, $3, 'ACTIVE', $4, $5)
        RETURNING 
          id,
          title,
          description,
          start_price as "startPrice",
          current_price as "currentPrice",
          status,
          seller_id as "sellerId",
          ends_at as "endsAt",
          created_at as "createdAt"`,
        [title, description || null, startPrice, sellerId, endsAt]
      );

      const auction = result.rows[0];

      return res.status(201).json({
        auction,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * PATCH /api/auctions/:id
   * Updates an auction's title, description, or endsAt before any bidding.
   * Only allowed for the seller when status is PENDING or ACTIVE and no bids exist.
   *
   * @param {import('express').Request<{ id: string }, {}, AuctionUpdatePayload>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const updateAuction = async (req, res, next) => {
    const { id } = req.params;
    const { title, description, endsAt } = req.body;
    const userId = req.user.id;

    try {
      const auctionResult = await db.query(
        `SELECT id, seller_id as "sellerId", status FROM auctions WHERE id = $1`,
        [id]
      );

      if (auctionResult.rows.length === 0) {
        return next(new AppError(404, 'Auction not found'));
      }

      const auction = auctionResult.rows[0];
      const sellerId = auction.sellerId ?? auction.seller_id;

      if (Number(sellerId) !== Number(userId)) {
        return next(new AppError(403, 'Only the seller can edit this auction'));
      }

      if (auction.status !== 'PENDING' && auction.status !== 'ACTIVE') {
        return next(new AppError(409, 'Auction cannot be edited in its current status'));
      }

      const bidsResult = await db.query(
        `SELECT id FROM bids WHERE auction_id = $1 LIMIT 1`,
        [id]
      );

      if (bidsResult.rows.length > 0) {
        return next(new AppError(409, 'Cannot edit auction that already has bids'));
      }

      const setClauses = [];
      const updateParams = [];

      if (title !== undefined) {
        updateParams.push(title);
        setClauses.push(`title = $${updateParams.length}`);
      }

      if (description !== undefined) {
        updateParams.push(description);
        setClauses.push(`description = $${updateParams.length}`);
      }

      if (endsAt !== undefined) {
        updateParams.push(endsAt);
        setClauses.push(`ends_at = $${updateParams.length}`);
      }

      updateParams.push(id);
      const idParamIndex = updateParams.length;

      updateParams.push(userId);
      const sellerIdParamIndex = updateParams.length;

      const updateResult = await db.query(
        `UPDATE auctions
         SET ${setClauses.join(', ')}
         WHERE id = $${idParamIndex} AND seller_id = $${sellerIdParamIndex}
         RETURNING 
           id,
           title,
           description,
           start_price as "startPrice",
           current_price as "currentPrice",
           status,
           seller_id as "sellerId",
           ends_at as "endsAt",
           created_at as "createdAt"`,
        updateParams
      );

      if (updateResult.rows.length === 0) {
        return next(new AppError(404, 'Auction not found'));
      }

      if (cache) {
        cache.delete(Number(id));
      }

      return res.status(200).json({
        auction: updateResult.rows[0],
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/auctions
   * Lists auctions with optional status filter, case-insensitive title search, and keyset pagination.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const listAuctions = async (req, res, next) => {
    const { status, limit, cursor, q } = req.query;

    try {
      const conditions = [];
      const params = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }

      if (q) {
        const escaped = escapeLike(q);
        params.push(`%${escaped}%`);
        conditions.push(`title ILIKE $${params.length}`);
      }

      if (cursor !== undefined) {
        params.push(cursor);
        conditions.push(`id < $${params.length}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      params.push(limit + 1);
      const limitParamIndex = params.length;

      const result = await db.query(
        `SELECT 
          id,
          title,
          description,
          start_price as "startPrice",
          current_price as "currentPrice",
          status,
          seller_id as "sellerId",
          ends_at as "endsAt",
          created_at as "createdAt"
        FROM auctions
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${limitParamIndex}`,
        params
      );

      const hasMore = result.rows.length > limit;
      const auctions = hasMore ? result.rows.slice(0, limit) : result.rows;
      const nextCursor = hasMore ? auctions[auctions.length - 1].id : null;

      return res.status(200).json({
        auctions,
        pagination: {
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/auctions/:id
   * Fetches a single auction by its unique identifier (read-through cache enabled).
   * Sets ETag (SHA-256 of the JSON body) and Cache-Control headers.
   * Returns 304 when If-None-Match header matches the ETag.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getAuctionById = async (req, res, next) => {
    const { id } = req.params;
    const auctionId = Number(id);

    try {
      let auction = cache?.get(auctionId);

      if (!auction) {
        const result = await db.query(
          `SELECT 
            id,
            title,
            description,
            start_price as "startPrice",
            current_price as "currentPrice",
            status,
            seller_id as "sellerId",
            ends_at as "endsAt",
            created_at as "createdAt"
          FROM auctions
          WHERE id = $1`,
          [id]
        );

        if (result.rows.length === 0) {
          return next(new AppError(404, 'Auction not found'));
        }

        auction = result.rows[0];
        if (cache) {
          cache.set(auctionId, auction);
        }
      }

      const body = {
        auction,
      };

      const bodyString = JSON.stringify(body);
      const hash = crypto.createHash('sha256').update(bodyString).digest('hex');
      const etag = `"${hash}"`;

      res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
      res.setHeader('ETag', etag);

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch) {
        const clientEtags = ifNoneMatch.split(',').map((s) => s.trim());
        const isMatch = clientEtags.some((clientEtag) => {
          if (clientEtag === '*') return true;
          const cleanClient = clientEtag.replace(/^W\//, '').replace(/^"|"$/g, '');
          return cleanClient === hash;
        });

        if (isMatch) {
          return res.status(304).end();
        }
      }

      return res.status(200).json(body);
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/auctions/:id/bids
   * Places a bid on an active auction using row-level locking.
   * Applies anti-sniping window extension if bid is placed in the last 2 minutes.
   * Publishes auction:<id> to eventBus after the transaction COMMITs.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const placeBid = async (req, res, next) => {
    const { id } = req.params;
    const { amount } = req.body;
    const userId = req.user.id;

    let client;
    try {
      client = await db.connect();
      await client.query('BEGIN');

      const auctionResult = await client.query(
        `SELECT 
          id,
          current_price as "currentPrice",
          status,
          seller_id as "sellerId",
          ends_at as "endsAt",
          COALESCE(original_ends_at, ends_at) as "originalEndsAt"
        FROM auctions
        WHERE id = $1
        FOR UPDATE`,
        [id]
      );

      if (auctionResult.rows.length === 0) {
        throw new AppError(404, 'Auction not found');
      }

      const auction = auctionResult.rows[0];

      if (Number(auction.sellerId) === Number(userId)) {
        throw new AppError(403, 'Sellers cannot bid on their own auctions');
      }

      const now = new Date();
      const endsAt = new Date(auction.endsAt);
      const rawOriginalEndsAt = auction.originalEndsAt ?? auction.original_ends_at ?? auction.endsAt;
      const originalEndsAt = new Date(rawOriginalEndsAt);

      if (auction.status !== 'ACTIVE' || endsAt <= now) {
        throw new AppError(409, 'Auction is not active or has ended');
      }

      const currentPrice = Number(auction.currentPrice);
      const minIncrement = Math.max(1.00, currentPrice * 0.05);
      const minRequired = currentPrice + minIncrement;

      if (amount < minRequired - 1e-9) {
        throw new AppError(
          409,
          `Bid amount must be at least ${minRequired.toFixed(2)}`
        );
      }

      const previousHighestBidResult = await client.query(
        `SELECT bidder_id as "bidderId" FROM bids WHERE auction_id = $1 ORDER BY amount DESC, id DESC LIMIT 1`,
        [id]
      );

      const bidResult = await client.query(
        `INSERT INTO bids (
          auction_id,
          bidder_id,
          amount
        ) VALUES ($1, $2, $3)
        RETURNING 
          id,
          auction_id as "auctionId",
          bidder_id as "bidderId",
          amount,
          created_at as "createdAt"`,
        [id, userId, amount]
      );

      if (previousHighestBidResult.rows.length > 0) {
        const prevBidderId = Number(previousHighestBidResult.rows[0].bidderId ?? previousHighestBidResult.rows[0].bidder_id);
        if (prevBidderId !== Number(userId)) {
          await client.query(
            `INSERT INTO notifications (user_id, auction_id, type) VALUES ($1, $2, 'OUTBID')`,
            [prevBidderId, id]
          );
        }
      }

      const twoMinutesMs = 2 * 60 * 1000;
      const thirtyMinutesMs = 30 * 60 * 1000;
      const timeRemainingMs = endsAt.getTime() - now.getTime();
      const isAntiSnipingWindow = timeRemainingMs <= twoMinutesMs;

      let updatedEndsAt = endsAt;

      if (isAntiSnipingWindow) {
        const candidateEndsAtMs = now.getTime() + twoMinutesMs;
        const maxEndsAtMs = originalEndsAt.getTime() + thirtyMinutesMs;
        const newEndsAtMs = Math.min(candidateEndsAtMs, maxEndsAtMs);

        if (newEndsAtMs > endsAt.getTime()) {
          updatedEndsAt = new Date(newEndsAtMs);
        }

        await client.query(
          `UPDATE auctions SET current_price = $1, ends_at = $3, original_ends_at = COALESCE(original_ends_at, $4) WHERE id = $2`,
          [amount, id, updatedEndsAt.toISOString(), originalEndsAt.toISOString()]
        );
      } else {
        await client.query(
          `UPDATE auctions SET current_price = $1 WHERE id = $2`,
          [amount, id]
        );
      }

      await client.query('COMMIT');

      if (cache) {
        cache.delete(Number(id));
      }

      const bid = bidResult.rows[0];

      const auctionResponse = {
        currentPrice: Number(amount),
      };

      if (isAntiSnipingWindow) {
        auctionResponse.endsAt = updatedEndsAt.toISOString();
      }

      const bidPayload = {
        bid: {
          id: Number(bid.id),
          auctionId: Number(bid.auctionId),
          bidderId: Number(bid.bidderId),
          amount: Number(bid.amount),
          createdAt: bid.createdAt,
        },
        auction: auctionResponse,
      };

      if (eventBus) {
        eventBus.emit(`auction:${id}`, bidPayload);
      }

      return res.status(201).json(bidPayload);
    } catch (err) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch (_) {
          // ignore rollback failure
        }
      }
      next(err);
    } finally {
      if (client) {
        client.release();
      }
    }
  };

  /**
   * GET /api/auctions/:id/bids
   * Fetches bid history for an auction, newest first, with bidder usernames and highest bid.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getBidHistory = async (req, res, next) => {
    const { id } = req.params;
    const { limit } = req.query;

    try {
      const auctionResult = await db.query(
        `SELECT id, current_price as "currentPrice" FROM auctions WHERE id = $1`,
        [id]
      );

      if (auctionResult.rows.length === 0) {
        return next(new AppError(404, 'Auction not found'));
      }

      const auction = auctionResult.rows[0];

      const bidsResult = await db.query(
        `SELECT 
          b.id,
          b.auction_id as "auctionId",
          b.bidder_id as "bidderId",
          b.amount,
          b.created_at as "createdAt",
          u.username as "bidderUsername"
        FROM bids b
        JOIN users u ON b.bidder_id = u.id
        WHERE b.auction_id = $1
        ORDER BY b.created_at DESC, b.id DESC
        LIMIT $2`,
        [id, limit]
      );

      const bids = bidsResult.rows.map((row) => ({
        id: Number(row.id),
        auctionId: Number(row.auctionId),
        bidderId: Number(row.bidderId),
        amount: Number(row.amount),
        createdAt: row.createdAt,
        bidderUsername: row.bidderUsername,
      }));

      return res.status(200).json({
        bids,
        highestBid: Number(auction.currentPrice),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/auctions/:id/events
   * Streams real-time Server-Sent Events (ready, bid events, 25s ping) for an auction.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const streamAuctionEvents = async (req, res, next) => {
    const { id } = req.params;

    try {
      const auctionResult = await db.query(
        `SELECT id FROM auctions WHERE id = $1`,
        [id]
      );

      if (auctionResult.rows.length === 0) {
        return next(new AppError(404, 'Auction not found'));
      }

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
      }

      res.write('event: ready\ndata: {"status":"ready"}\n\n');

      const channel = `auction:${id}`;
      const onBid = (data) => {
        res.write(`event: bid\ndata: ${JSON.stringify(data)}\n\n`);
      };

      if (eventBus) {
        eventBus.on(channel, onBid);
      }

      const pingTimer = setInterval(() => {
        res.write(': ping\n\n');
      }, pingIntervalMs);

      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(pingTimer);
        if (eventBus) {
          eventBus.removeListener(channel, onBid);
        }
      };

      req.on('close', cleanup);
      res.on('close', cleanup);
    } catch (err) {
      next(err);
    }
  };

  return {
    createAuction,
    updateAuction,
    listAuctions,
    getAuctionById,
    placeBid,
    getBidHistory,
    streamAuctionEvents,
  };
}

export default createAuctionController;
