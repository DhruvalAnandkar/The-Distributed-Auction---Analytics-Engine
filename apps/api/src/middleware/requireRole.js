import AppError from '../utils/AppError.js';

/**
 * Express middleware factory that enforces user role authorization.
 * Always reads the user role directly from the database, never trusting JWT claims.
 *
 * @param {string | string[]} expectedRole - Required role or array of allowed roles.
 * @param {Object} [options]
 * @param {{ query: Function }} [options.db] - Optional node-postgres compatible query interface.
 * @returns {import('express').RequestHandler}
 */
export function requireRole(expectedRole, options = {}) {
  const allowedRoles = Array.isArray(expectedRole) ? expectedRole : [expectedRole];

  return async (req, res, next) => {
    const db = options.db || req.db || req.app?.get?.('db') || req.app?.locals?.db;
    if (!db) {
      return next(new Error('Database connection not available in requireRole'));
    }

    const userId = req.user?.id;
    if (!userId) {
      return next(new AppError(401, 'Missing or malformed authorization token'));
    }

    try {
      const result = await db.query(
        'SELECT role FROM users WHERE id = $1',
        [userId]
      );

      if (result.rows.length === 0) {
        return next(new AppError(404, 'User not found'));
      }

      const role = result.rows[0].role;
      if (!allowedRoles.includes(role)) {
        return next(new AppError(403, 'Forbidden'));
      }

      req.user.role = role;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Creates a requireRole factory bound to a specific db instance.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db
 * @returns {(expectedRole: string | string[]) => import('express').RequestHandler}
 */
export function createRequireRole({ db }) {
  return (expectedRole) => requireRole(expectedRole, { db });
}

export default requireRole;
