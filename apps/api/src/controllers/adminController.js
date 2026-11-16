import { closeExpiredAuctions } from '../services/auctionCloser.js';

/**
 * Builds the admin controller with injected database dependency.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible interface.
 * @param {Object} [deps.cache] - LRU cache instance.
 */
export function createAdminController({ db, cache }) {
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
      const auctions = await closeExpiredAuctions({ db, now, cache });

      return res.status(200).json({
        auctions,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * GET /api/admin/users
   * Lists users with keyset pagination, omitting password hashes.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const listUsers = async (req, res, next) => {
    const { limit, cursor, role } = req.query;

    try {
      const conditions = [];
      const params = [];

      if (role) {
        params.push(role);
        conditions.push(`role = $${params.length}`);
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
          username,
          email,
          role,
          created_at as "createdAt"
        FROM users
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${limitParamIndex}`,
        params
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const users = rows.map((row) => ({
        id: Number(row.id),
        username: row.username,
        email: row.email,
        role: row.role,
        createdAt: row.createdAt ?? row.created_at,
      }));

      const nextCursor = hasMore ? users[users.length - 1].id : null;

      return res.status(200).json({
        users,
        pagination: {
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  return {
    closeExpired,
    listUsers,
  };
}

export default createAdminController;
