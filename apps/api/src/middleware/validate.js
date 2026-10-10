import AppError from '../utils/AppError.js';

/**
 * Express middleware factory that validates request data against a Zod schema.
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
    req[source] = result.data;
    next();
  };
}

export default validate;
