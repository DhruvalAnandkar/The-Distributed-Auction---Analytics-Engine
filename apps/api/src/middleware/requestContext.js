import crypto from 'node:crypto';

/**
 * Middleware that assigns each request a unique identifier, echoes it in the response header,
 * logs a structured JSON line on finish, and attaches it to request and response locals.
 */
export function requestContext(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  let requestId;

  if (typeof incomingId === 'string' && incomingId.length > 0 && incomingId.length <= 64 && /^[a-zA-Z0-9_\-]+$/.test(incomingId)) {
    requestId = incomingId;
  } else {
    requestId = crypto.randomUUID();
  }

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  res.locals = res.locals || {};
  res.locals.requestId = requestId;

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationNs = process.hrtime.bigint() - start;
    const durationMs = Number(durationNs) / 1_000_000;

    const logEntry = {
      requestId,
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(3)),
    };

    console.log(JSON.stringify(logEntry));
  });

  next();
}

export default requestContext;
