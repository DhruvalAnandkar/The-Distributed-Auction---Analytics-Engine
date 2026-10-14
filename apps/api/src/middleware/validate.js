import AppError from '../utils/AppError.js';

/**
 * Express middleware factory that validates request data against a Zod schema.
 *
 * On success the parsed (coerced, defaulted) data replaces the original, so
 * handlers keep reading `req.body`, `req.query` or `req.params`. It is also
 * stored under `req.validated[source]`.
 *
 * Express 5 exposes `req.query` as a getter-only property, so plain assignment
 * throws a TypeError. We define an own property on the request instead, which
 * shadows the getter for this request only.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema to validate against.
 * @param {'body' | 'query' | 'params'} [source='body'] - Request property to validate.
 * @returns {import('express').RequestHandler}
 */
export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      return next(new AppError(400, 'Validation failed', details));
    }

    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    req.validated = { ...(req.validated || {}), [source]: result.data };
    next();
  };
}

export default validate;
