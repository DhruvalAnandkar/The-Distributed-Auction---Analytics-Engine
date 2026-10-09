import AppError from '../utils/AppError.js';

/**
 * Centralized error handling middleware.
 *
 * @param {any} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function errorHandler(err, req, res, next) {
  // Handle malformed JSON body error from express.json()
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  if (err instanceof AppError) {
    const response = { error: err.message };
    if (err.details !== undefined) {
      response.details = err.details;
    }
    return res.status(err.statusCode).json(response);
  }

  // Log unexpected errors
  console.error(`[Unexpected Error] ${err.stack || err.message || err}`);

  // Return generic 500 without leaking err.message
  return res.status(500).json({
    error: 'Internal server error'
  });
}

export default errorHandler;
