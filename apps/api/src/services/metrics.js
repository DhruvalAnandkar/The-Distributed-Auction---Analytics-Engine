import crypto from 'node:crypto';

/**
 * Standard Prometheus histogram buckets for HTTP duration (in seconds).
 */
const DEFAULT_BUCKETS = Object.freeze([
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
]);

/**
 * Escapes characters in label values according to Prometheus text format specs.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeLabel(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/**
 * Extracts normalized route pattern from Express request object.
 *
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getRoutePattern(req) {
  if (!req || !req.route) {
    return 'unknown';
  }
  const baseUrl = req.baseUrl || '';
  const routePath = req.route.path;

  let pathStr = '';
  if (typeof routePath === 'string') {
    pathStr = routePath;
  } else if (Array.isArray(routePath)) {
    pathStr = routePath.join('');
  } else if (routePath) {
    pathStr = String(routePath);
  }

  if (pathStr === '/') {
    return baseUrl || '/';
  }

  return `${baseUrl}${pathStr}` || 'unknown';
}

/**
 * Validates request authorization against METRICS_TOKEN if configured.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {boolean} True if authorized or token not set, false if rejected.
 */
export function checkMetricsAuth(req, res) {
  const metricsToken = process.env.METRICS_TOKEN;
  if (!metricsToken) {
    return true;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid metrics token' });
    return false;
  }

  const token = authHeader.slice(7).trim();
  const tokenBuf = Buffer.from(token);
  const metricsBuf = Buffer.from(metricsToken);

  let isValid = false;
  if (tokenBuf.length === metricsBuf.length) {
    isValid = crypto.timingSafeEqual(tokenBuf, metricsBuf);
  } else {
    crypto.timingSafeEqual(tokenBuf, tokenBuf);
  }

  if (!isValid) {
    res.status(401).json({ error: 'Invalid metrics token' });
    return false;
  }

  return true;
}

/**
 * Creates Prometheus metrics collector instance.
 *
 * @param {Object} [options]
 * @param {() => number} [options.now=Date.now] - Time provider returning timestamp in milliseconds.
 * @returns {Object} Metrics collector interface.
 */
export function createMetrics({ now = Date.now } = {}) {
  const seriesMap = new Map();
  const buckets = DEFAULT_BUCKETS;

  /**
   * Record a completed HTTP request observation.
 *
   * @param {string} method
   * @param {string} route
   * @param {string|number} status
   * @param {number} durationSeconds
   */
  function observe(method, route, status, durationSeconds) {
    const normMethod = (method || 'GET').toUpperCase();
    const normRoute = route || 'unknown';
    const normStatus = String(status || '200');
    const key = `${normMethod}|${normRoute}|${normStatus}`;

    let series = seriesMap.get(key);
    if (!series) {
      series = {
        method: normMethod,
        route: normRoute,
        status: normStatus,
        count: 0,
        sum: 0,
        bucketCounts: new Array(buckets.length).fill(0),
      };
      seriesMap.set(key, series);
    }

    series.count += 1;
    series.sum += durationSeconds;

    for (let i = 0; i < buckets.length; i++) {
      if (durationSeconds <= buckets[i]) {
        series.bucketCounts[i] += 1;
      }
    }
  }

  /**
   * Express middleware to capture duration and count of requests.
   */
  function middleware(req, res, next) {
    const start = now();
    res.on('finish', () => {
      const end = now();
      const durationMs = end - start;
      const durationSeconds = durationMs / 1000;
      const route = getRoutePattern(req);
      observe(req.method, route, res.statusCode, durationSeconds);
    });
    next();
  }

  /**
   * Generates Prometheus exposition text format.
 *
   * @returns {string}
   */
  function toPrometheus() {
    const lines = [
      '# HELP http_requests_total Total number of HTTP requests',
      '# TYPE http_requests_total counter',
    ];

    for (const series of seriesMap.values()) {
      const labels = `method="${escapeLabel(series.method)}",route="${escapeLabel(series.route)}",status="${escapeLabel(series.status)}"`;
      lines.push(`http_requests_total{${labels}} ${series.count}`);
    }

    lines.push('');
    lines.push('# HELP http_request_duration_seconds HTTP request duration in seconds');
    lines.push('# TYPE http_request_duration_seconds histogram');

    for (const series of seriesMap.values()) {
      const baseLabels = `method="${escapeLabel(series.method)}",route="${escapeLabel(series.route)}",status="${escapeLabel(series.status)}"`;
      for (let i = 0; i < buckets.length; i++) {
        const le = buckets[i];
        lines.push(`http_request_duration_seconds_bucket{le="${le}",${baseLabels}} ${series.bucketCounts[i]}`);
      }
      lines.push(`http_request_duration_seconds_bucket{le="+Inf",${baseLabels}} ${series.count}`);
      lines.push(`http_request_duration_seconds_sum{${baseLabels}} ${series.sum}`);
      lines.push(`http_request_duration_seconds_count{${baseLabels}} ${series.count}`);
    }

    return lines.join('\n') + '\n';
  }

  return {
    observe,
    middleware,
    toPrometheus,
    getMetrics: toPrometheus,
  };
}

export default createMetrics;
