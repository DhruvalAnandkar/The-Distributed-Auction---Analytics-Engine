/**
 * Express middleware that sets baseline HTTP security headers and removes X-Powered-By.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function securityHeaders(req, res, next) {
  if (req.app && typeof req.app.disable === 'function') {
    req.app.disable('x-powered-by');
  }
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  next();
}

export default securityHeaders;
