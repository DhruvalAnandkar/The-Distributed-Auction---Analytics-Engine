import AppError from '../utils/AppError.js';

/**
 * @typedef {Object} AuctionCreationPayload
 * @property {string} title - Auction title.
 * @property {string} [description] - Optional auction description.
 * @property {number} startPrice - Starting price (> 0).
 * @property {string} endsAt - ISO date string at least 1 min in the future.
 */

/**
 * Builds the auction controller with its dependencies injected.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 */
export function createAuctionController({ db }) {
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
   * GET /api/auctions
   * Lists auctions with optional status filter and keyset pagination.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const listAuctions = async (req, res, next) => {
    const { status, limit, cursor } = req.query;

    try {
      const conditions = [];
      const params = [];

      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
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
   * Fetches a single auction by its unique identifier.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getAuctionById = async (req, res, next) => {
    const { id } = req.params;

    try {
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

      return res.status(200).json({
        auction: result.rows[0],
      });
    } catch (err) {
      next(err);
    }
  };

  return { createAuction, listAuctions, getAuctionById };
}

export default createAuctionController;
