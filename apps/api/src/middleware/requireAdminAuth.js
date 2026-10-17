import crypto from 'node:crypto';
import AppError from '../utils/AppError.js';

/**
 * Middleware to authenticate administrative requests via X-Admin-Token header.
 * Performs constant-time buffer comparison with crypto.timingSafeEqual against process.env.ADMIN_TOKEN.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAdminAuth(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  const rawHeader = req.headers['x-admin-token'];
  const token = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  if (!adminToken || !token || typeof token !== 'string') {
    return next(new AppError(401, 'Missing or invalid admin token'));
  }

  const tokenBuffer = Buffer.from(token);
  const adminBuffer = Buffer.from(adminToken);

  let isValid = false;
  if (tokenBuffer.length === adminBuffer.length) {
    isValid = crypto.timingSafeEqual(tokenBuffer, adminBuffer);
  } else {
    crypto.timingSafeEqual(tokenBuffer, tokenBuffer);
  }

  if (!isValid) {
    return next(new AppError(401, 'Invalid admin token'));
  }

  next();
}

export default requireAdminAuth;
