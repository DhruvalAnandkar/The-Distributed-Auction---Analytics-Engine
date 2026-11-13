import express from 'express';
import defaultPool from './config/db.js';
import { createUserRouter } from './routes/userRoutes.js';
import { createAuctionRouter } from './routes/auctionRoutes.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { createWatchlistRouter } from './routes/watchlistRoutes.js';
import { createAnalyticsRouter } from './routes/analyticsRoutes.js';
import { createNotificationRouter } from './routes/notificationRoutes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';
import { securityHeaders } from './middleware/securityHeaders.js';
import { createCors } from './middleware/cors.js';
import { createMetrics, checkMetricsAuth } from './services/metrics.js';
import { createCache } from './services/cache.js';
import { eventBus as defaultEventBus } from './services/eventBus.js';

/**
 * Builds the Express application.
 *
 * @param {Object} [deps]
 * @param {{ query: Function, connect?: Function }} [deps.db] - Anything with the
 *   node-postgres `query` interface. Defaults to the shared connection pool.
 * @param {number} [deps.readinessTimeoutMs=1000] - Timeout in milliseconds for readiness probe.
 * @param {string | number} [deps.bodyLimit='100kb'] - Request body size limit for express.json.
 * @param {string | string[] | Set<string>} [deps.corsOrigins] - Allowed origins for CORS.
 * @param {string | string[] | Set<string>} [deps.origins] - Alias for corsOrigins.
 * @param {Function} [deps.now] - Custom time provider function for metrics.
 * @param {Object} [deps.metrics] - Custom metrics collector instance.
 * @param {Object} [deps.cache] - Custom LRU cache instance.
 * @param {import('node:events').EventEmitter} [deps.eventBus] - Custom event bus instance.
 * @param {number} [deps.pingIntervalMs=25000] - Ping interval in milliseconds for SSE.
 * @returns {import('express').Express}
 */
export function createApp({
  db = defaultPool,
  readinessTimeoutMs = 1000,
  bodyLimit = '100kb',
  corsOrigins,
  origins,
  now,
  metrics: injectedMetrics,
  cache: injectedCache,
  eventBus: injectedEventBus,
  pingIntervalMs,
} = {}) {
  const app = express();
  const metrics = injectedMetrics || createMetrics({ now });
  const cache = injectedCache !== undefined ? injectedCache : createCache();
  const eventBus = injectedEventBus !== undefined ? injectedEventBus : defaultEventBus;

  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(createCors({ origins: origins !== undefined ? origins : corsOrigins }));
  app.use(express.json({ limit: bodyLimit }));
  app.use(requestContext);
  app.use(metrics.middleware);

  app.get('/metrics', (req, res) => {
    if (!checkMetricsAuth(req, res)) {
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(metrics.toPrometheus());
  });

  app.use('/api/users', createUserRouter({ db }));
  app.use('/api/auctions', createAuctionRouter({ db, cache, eventBus, pingIntervalMs }));
  app.use('/api/admin', createAdminRouter({ db, cache }));
  app.use('/api/watchlist', createWatchlistRouter({ db }));
  app.use('/api/analytics', createAnalyticsRouter({ db }));
  app.use('/api/users/me/notifications', createNotificationRouter({ db }));

  app.get('/health/ready', async (req, res) => {
    let timer;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Database query timed out'));
        }, readinessTimeoutMs);
      });

      await Promise.race([db.query('SELECT 1'), timeoutPromise]);

      return res.status(200).json({
        status: 'UP',
        services: {
          database: 'UP',
        },
      });
    } catch (err) {
      return res.status(503).json({
        status: 'DOWN',
        error: 'Database unavailable',
        services: {
          database: 'DOWN',
        },
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });

  app.get('/health', async (req, res) => {
    let dbStatus = 'DOWN';
    try {
      await db.query('SELECT 1');
      dbStatus = 'UP';
    }
    catch (err) {
      console.error(`[Health Check Error] Database connectivity failed: ${err.message}`);
    }

    res.status(200).json({
      status: 'UP',
      services: {
        gateway: 'UP',
        database: dbStatus,
      },
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Unknown routes handler
  app.use(notFound);

  // Centralized error handler
  app.use(errorHandler);

  return app;
}

export default createApp;
