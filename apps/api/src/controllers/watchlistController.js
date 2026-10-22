import AppError from '../utils/AppError.js';

/**
 * Builds the watchlist controller with its dependencies injected.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 */
export function createWatchlistController({ db }) {
  /**
   * POST /api/watchlist/:auctionId
   * Adds an auction to the authenticated user's watchlist idempotently.
   * Returns 201 when newly added, or 200 if already in the watchlist.
   *
   * @param {import('express').Request<{ auctionId: string }>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const addToWatchlist = async (req, res, next) => {
    const userId = req.user.id;
    const { auctionId } = req.params;

    try {
      const auctionResult = await db.query(
        'SELECT id FROM auctions WHERE id = $1',
        [auctionId]
      );

      if (auctionResult.rows.length === 0) {
        return next(new AppError(404, 'Auction not found'));
      }

      const insertResult = await db.query(
        `INSERT INTO watchlist (user_id, auction_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING
         RETURNING auction_id`,
        [userId, auctionId]
      );

      const inserted =
        (insertResult.rowCount !== undefined && insertResult.rowCount > 0) ||
        (insertResult.rows && insertResult.rows.length > 0);

      const status = inserted ? 201 : 200;

      return res.status(status).json({
        message: inserted
          ? 'Auction added to watchlist'
          : 'Auction already in watchlist',
        watchlist: {
          userId: Number(userId),
          auctionId: Number(auctionId),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * DELETE /api/watchlist/:auctionId
   * Removes an auction from the authenticated user's watchlist.
   * Always returns 204.
   *
   * @param {import('express').Request<{ auctionId: string }>} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const removeFromWatchlist = async (req, res, next) => {
    const userId = req.user.id;
    const { auctionId } = req.params;

    try {
      await db.query(
        'DELETE FROM watchlist WHERE user_id = $1 AND auction_id = $2',
        [userId, auctionId]
      );

      return res.status(204).end();
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/watchlist
   * Lists all auctions watched by the authenticated user, newest first.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getWatchlist = async (req, res, next) => {
    const userId = req.user.id;

    try {
      const result = await db.query(
        `SELECT 
          a.id,
          a.title,
          a.description,
          a.start_price as "startPrice",
          a.current_price as "currentPrice",
          a.status,
          a.seller_id as "sellerId",
          a.ends_at as "endsAt",
          a.created_at as "createdAt"
        FROM watchlist w
        JOIN auctions a ON w.auction_id = a.id
        WHERE w.user_id = $1
        ORDER BY w.created_at DESC, w.auction_id DESC`,
        [userId]
      );

      const auctions = result.rows.map((row) => ({
        id: Number(row.id),
        title: row.title,
        description: row.description !== undefined ? row.description : null,
        startPrice:
          row.startPrice !== undefined
            ? typeof row.startPrice === 'string'
              ? Number(row.startPrice)
              : row.startPrice
            : Number(row.start_price),
        currentPrice:
          row.currentPrice !== undefined
            ? typeof row.currentPrice === 'string'
              ? Number(row.currentPrice)
              : row.currentPrice
            : Number(row.current_price),
        status: row.status,
        sellerId: Number(row.sellerId ?? row.seller_id),
        endsAt: row.endsAt ?? row.ends_at,
        createdAt: row.createdAt ?? row.created_at,
      }));

      return res.status(200).json({
        auctions,
      });
    } catch (err) {
      next(err);
    }
  };

  return {
    addToWatchlist,
    removeFromWatchlist,
    getWatchlist,
  };
}

export default createWatchlistController;
