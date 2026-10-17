import express from 'express';
import defaultPool from './config/db.js';
import { createUserRouter } from './routes/userRoutes.js';
import { createAuctionRouter } from './routes/auctionRoutes.js';
import { createAdminRouter } from './routes/adminRoutes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';
import { requestContext } from './middleware/requestContext.js';

/**
 * Builds the Express application.
 *
 * @param {Object} [deps]
 * @param {{ query: Function, connect?: Function }} [deps.db] - Anything with the
 *   node-postgres `query` interface. Defaults to the shared connection pool.
 * @param {number} [deps.readinessTimeoutMs=1000] - Timeout in milliseconds for readiness probe.
 * @returns {import('express').Express}
 */
export function createApp({ db = defaultPool, readinessTimeoutMs = 1000 } = {}) {
  const app = express();

  app.use(express.json());
  app.use(requestContext);

  app.use('/api/users', createUserRouter({ db }));
  app.use('/api/auctions', createAuctionRouter({ db }));
  app.use('/api/admin', createAdminRouter({ db }));

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
    } catch (err) {
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
