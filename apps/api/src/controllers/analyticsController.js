import AppError from '../utils/AppError.js';

/**
 * Whitelist map from window query parameter values to Postgres interval expressions.
 * User input is never interpolated into SQL; intervals are resolved strictly from this map.
 */
const WINDOW_INTERVAL_MAP = Object.freeze({
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
});

/**
 * Builds the analytics controller with its database dependency injected.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 */
export function createAnalyticsController({ db }) {
  /**
   * GET /api/analytics/top-auctions
   * Returns auctions ranked by bid count in the specified time window.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getTopAuctions = async (req, res, next) => {
    const { window, limit } = req.query;

    const interval = WINDOW_INTERVAL_MAP[window];
    if (!interval) {
      return next(new AppError(400, 'Invalid window parameter'));
    }

    try {
      const result = await db.query(
        `SELECT 
          a.id,
          a.title,
          a.current_price as "currentPrice",
          COUNT(b.id)::int as "bidCount",
          COUNT(DISTINCT b.bidder_id)::int as "uniqueBidders"
        FROM auctions a
        JOIN bids b ON b.auction_id = a.id
        WHERE b.created_at >= NOW() - $1::interval
        GROUP BY a.id, a.title, a.current_price
        ORDER BY COUNT(b.id) DESC, a.id DESC
        LIMIT $2`,
        [interval, limit]
      );

      const auctions = result.rows.map((row) => ({
        id: Number(row.id),
        title: row.title,
        bidCount: Number(row.bidCount ?? row.bid_count ?? 0),
        uniqueBidders: Number(row.uniqueBidders ?? row.unique_bidders ?? 0),
        currentPrice: Number(row.currentPrice ?? row.current_price ?? 0),
      }));

      return res.status(200).json({
        auctions,
      });
    } catch (err) {
      next(err);
    }
  };

  return { getTopAuctions };
}

export default createAnalyticsController;
