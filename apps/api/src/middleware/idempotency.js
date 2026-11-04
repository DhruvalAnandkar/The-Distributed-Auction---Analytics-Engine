import crypto from 'node:crypto';
import AppError from '../utils/AppError.js';

/**
 * Creates Express middleware for handling Idempotency-Key headers.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').RequestHandler}
 */
export function createIdempotencyMiddleware({ db }) {
  return async (req, res, next) => {
    const rawKey = req.headers['idempotency-key'];
    if (!rawKey || typeof rawKey !== 'string' || !rawKey.trim()) {
      return next();
    }

    const key = rawKey.trim();
    const userId = req.user?.id;
    if (!userId) {
      return next();
    }

    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(req.body ?? {}))
      .digest('hex');

    try {
      const result = await db.query(
        `SELECT request_hash AS "requestHash", status_code AS "statusCode", response_body AS "responseBody", created_at AS "createdAt" FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
        [userId, key]
      );

      if (result.rows.length > 0) {
        const row = result.rows[0];
        const createdAt = new Date(row.createdAt ?? row.created_at);
        const ageMs = Date.now() - createdAt.getTime();
        const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

        if (ageMs < TWENTY_FOUR_HOURS_MS) {
          const storedHash = row.requestHash ?? row.request_hash;
          if (storedHash !== requestHash) {
            return next(new AppError(409, 'Idempotency key payload mismatch'));
          }

          const statusCode = Number(row.statusCode ?? row.status_code);
          let body = row.responseBody ?? row.response_body;
          if (typeof body === 'string') {
            try {
              body = JSON.parse(body);
            } catch (_) {}
          }

          res.setHeader('Idempotent-Replayed', 'true');
          return res.status(statusCode).json(body);
        } else {
          await db.query(
            `DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
            [userId, key]
          );
        }
      }

      const originalJson = res.json;

      res.json = function (body) {
        res.json = originalJson;

        if (res.statusCode < 500) {
          db.query(
            `INSERT INTO idempotency_keys (user_id, key, request_hash, status_code, response_body) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (user_id, key) DO UPDATE SET request_hash = EXCLUDED.request_hash, status_code = EXCLUDED.status_code, response_body = EXCLUDED.response_body, created_at = CURRENT_TIMESTAMP`,
            [userId, key, requestHash, res.statusCode, JSON.stringify(body)]
          ).catch((err) => {
            console.error('[Idempotency] persistence error:', err.message);
          });
        }

        return originalJson.call(res, body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

export default createIdempotencyMiddleware;
