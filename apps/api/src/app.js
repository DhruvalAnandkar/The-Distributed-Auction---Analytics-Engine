/**
 * @fileoverview Express application factory for the API Gateway.
 *
 * The app is built by a factory instead of at import time so that tests (and the
 * autonomous agent's verification step) can create an app with a fake database
 * and drive it with supertest, without opening a port or a Postgres connection.
 */

import express from 'express';
import defaultPool from './config/db.js';
import { createUserRouter } from './routes/userRoutes.js';

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

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`[Server Error] ${err.message}`);
    res.status(500).json({
      error: 'Internal server error',
      message: err.message || 'An unexpected error occurred',
    });
  });

  return app;
}

export default createApp;
