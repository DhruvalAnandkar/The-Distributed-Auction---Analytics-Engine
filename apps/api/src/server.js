/**
 * @fileoverview Process entry point: loads env, builds the app, opens the port.
 * All request handling lives in app.js so it can be tested without a server.
 */

import dotenv from 'dotenv';
import { createApp } from './app.js';
import pool from './config/db.js';
import { createShutdown } from './utils/shutdown.js';

dotenv.config();

const PORT = process.env.PORT || 5001;

const app = createApp({ db: pool });

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

const shutdown = createShutdown({ server, db: pool });

process.on('SIGTERM', () => {
  shutdown('SIGTERM')
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Graceful shutdown failed:', err);
      process.exit(1);
    });
});

process.on('SIGINT', () => {
  shutdown('SIGINT')
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Graceful shutdown failed:', err);
      process.exit(1);
    });
});
