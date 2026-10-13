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

  return { createAuction };
}

export default createAuctionController;
