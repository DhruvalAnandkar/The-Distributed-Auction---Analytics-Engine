/**
 * @fileoverview Process entry point: loads env, builds the app, opens the port.
 * All request handling lives in app.js so it can be tested without a server.
 */

import dotenv from 'dotenv';
import { createApp } from './app.js';

dotenv.config();

const PORT = process.env.PORT || 5001;

const app = createApp();

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
