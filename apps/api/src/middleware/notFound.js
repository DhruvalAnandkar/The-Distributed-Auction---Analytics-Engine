import AppError from '../utils/AppError.js';

/**
 * Middleware to handle 404 Not Found for unknown routes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function notFound(req, res, next) {
  next(new AppError(404, 'Not found'));
}

export default notFound;
