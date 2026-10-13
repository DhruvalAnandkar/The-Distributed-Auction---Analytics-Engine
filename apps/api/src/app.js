import express from 'express';
import defaultPool from './config/db.js';
import { createUserRouter } from './routes/userRoutes.js';
import { createAuctionRouter } from './routes/auctionRoutes.js';
import { notFound } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

/**
 * Builds the Express application.
 *
 * @param {Object} [deps]
 * @param {{ query: Function, connect?: Function }} [deps.db] - Anything with the
 *   node-postgres `query` interface. Defaults to the shared connection pool.
 * @returns {import('express').Express}
 */
export function createApp({ db = defaultPool } = {}) {
  const app = express();

  app.use(express.json());

  app.use('/api/users', createUserRouter({ db }));
  app.use('/api/auctions', createAuctionRouter({ db }));

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
