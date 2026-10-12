import { verifyToken } from '../services/tokenService.js';
import AppError from '../utils/AppError.js';

/**
 * Middleware to authenticate requests via Authorization: Bearer <jwt>.
 * Verifies the token using tokenService and sets req.user = { id, username }.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new AppError(401, 'Missing or malformed authorization token'));
  }

  const token = authHeader.split(' ')[1];
  if (!token) {
    return next(new AppError(401, 'Missing authorization token'));
  }

  try {
    const decoded = verifyToken(token);
    // The payload uses sub for id and username for username as per tokenService
    req.user = {
      id: decoded.sub,
      username: decoded.username,
    };
    next();
  } catch (err) {
    return next(new AppError(401, 'Invalid or expired token'));
  }
}

export default requireAuth;
