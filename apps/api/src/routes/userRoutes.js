import express from 'express';
import { createUserController } from '../controllers/userController.js';
import { validate } from '../middleware/validate.js';
import { registerSchema, loginSchema } from '../validators/userValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { createRateLimiter } from '../middleware/rateLimit.js';

/**
 * Builds the /api/users router.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createUserRouter({ db }) {
  const router = express.Router();
  const users = createUserController({ db });

  const loginRateLimiter = createRateLimiter({
    capacity: 5,
    refillPerSecond: 0.2, // 1 token every 5 seconds
    key: (req) => req.ip || req.socket.remoteAddress || 'unknown-ip',
  });

  // POST /api/users/register
  router.post('/register', validate(registerSchema), users.registerUser);

  // POST /api/users/login
  router.post('/login', loginRateLimiter, validate(loginSchema), users.loginUser);

  // GET /api/users/me
  router.get('/me', requireAuth, users.getCurrentUser);

  return router;
}

export default createUserRouter;
