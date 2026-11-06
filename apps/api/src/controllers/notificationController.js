import AppError from '../utils/AppError.js';

/**
 * Builds the notification controller with injected database dependency.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 */
export function createNotificationController({ db }) {
  /**
   * GET /api/users/me/notifications
   * Lists notifications for the authenticated user with keyset pagination and unreadOnly filter.
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const getNotifications = async (req, res, next) => {
    const userId = req.user.id;
    const { limit, cursor, unreadOnly } = req.query;

    try {
      const conditions = ['user_id = $1'];
      const params = [userId];

      if (unreadOnly === true || unreadOnly === 'true') {
        conditions.push('read = FALSE');
      }

      if (cursor !== undefined) {
        params.push(cursor);
        conditions.push(`id < $${params.length}`);
      }

      const whereClause = `WHERE ${conditions.join(' AND ')}`;

      params.push(limit + 1);
      const limitParamIndex = params.length;

      const result = await db.query(
        `SELECT 
          id,
          user_id as "userId",
          auction_id as "auctionId",
          type,
          read,
          created_at as "createdAt"
        FROM notifications
        ${whereClause}
        ORDER BY id DESC
        LIMIT $${limitParamIndex}`,
        params
      );

      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

      const notifications = rows.map((row) => ({
        id: Number(row.id),
        userId: Number(row.userId ?? row.user_id),
        auctionId: Number(row.auctionId ?? row.auction_id),
        type: row.type,
        read: Boolean(row.read),
        createdAt: row.createdAt ?? row.created_at,
      }));

      const nextCursor = hasMore ? notifications[notifications.length - 1].id : null;

      return res.status(200).json({
        notifications,
        pagination: {
          nextCursor,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * POST /api/users/me/notifications/:id/read
   * Marks an individual notification as read, ensuring ownership (caller's own only).
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  const markAsRead = async (req, res, next) => {
    const userId = req.user.id;
    const { id } = req.params;

    try {
      const result = await db.query(
        `UPDATE notifications
         SET read = TRUE
         WHERE id = $1 AND user_id = $2
         RETURNING 
           id,
           user_id as "userId",
           auction_id as "auctionId",
           type,
           read,
           created_at as "createdAt"`,
        [id, userId]
      );

      if (result.rows.length === 0) {
        return next(new AppError(404, 'Notification not found'));
      }

      const row = result.rows[0];

      return res.status(200).json({
        notification: {
          id: Number(row.id),
          userId: Number(row.userId ?? row.user_id),
          auctionId: Number(row.auctionId ?? row.auction_id),
          type: row.type,
          read: Boolean(row.read),
          createdAt: row.createdAt ?? row.created_at,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  return {
    getNotifications,
    markAsRead,
  };
}

export default createNotificationController;
