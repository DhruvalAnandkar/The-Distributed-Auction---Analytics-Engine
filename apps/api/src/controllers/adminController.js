import { closeExpiredAuctions } from '../services/auctionCloser.js';

/**
 * Builds the admin controller with injected database dependency.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible interface.
 */
export function createAdminController({ db }) {
  /**
   * POST /api/admin/auctions/close-expired
   * Closes active expired auctions and returns winning details.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const closeExpired = async (req, res, next) => {
    try {
      const now = req.body?.now ? new Date(req.body.now) : undefined;
      const auctions = await closeExpiredAuctions({ db, now });

      return res.status(200).json({
        auctions,
      });
    } catch (err) {
      next(err);
    }
  };

  return { closeExpired };
}

export default createAdminController;
