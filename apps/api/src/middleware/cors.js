/**
 * Normalizes origins input into a list of strings.
 *
 * @param {string | string[] | Set<string> | undefined | null} raw
 * @returns {string[]}
 */
function parseOrigins(raw) {
  if (!raw) {
    return [];
  }
  if (Array.isArray(raw)) {
    return raw.map((s) => (typeof s === 'string' ? s.trim() : s)).filter(Boolean);
  }
  if (raw instanceof Set) {
    return Array.from(raw).map((s) => (typeof s === 'string' ? s.trim() : s)).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Creates CORS middleware with configurable origin allow-list.
 *
 * @param {Object} [options]
 * @param {string | string[] | Set<string>} [options.origins] - Allowed origins. Defaults to process.env.CORS_ORIGINS.
 * @returns {import('express').RequestHandler}
 */
export function createCors(options = {}) {
  const origins = options && typeof options === 'object' && !Array.isArray(options) && !(options instanceof Set)
    ? options.origins
    : options;

  const staticAllowed = origins !== undefined ? new Set(parseOrigins(origins)) : null;

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (!origin) {
      return next();
    }

    const allowed = staticAllowed || new Set(parseOrigins(process.env.CORS_ORIGINS));

    if (!allowed.has(origin)) {
      return next();
    }

    res.setHeader('Access-Control-Allow-Origin', origin);

    const existingVary = res.getHeader('Vary');
    if (!existingVary) {
      res.setHeader('Vary', 'Origin');
    } else {
      const parts = String(existingVary).split(',').map((s) => s.trim());
      if (!parts.includes('Origin')) {
        res.setHeader('Vary', `${existingVary}, Origin`);
      }
    }

    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }

    next();
  };
}

export default createCors;
