import express from 'express';
import { createUserController } from '../controllers/userController.js';
import { validate } from '../middleware/validate.js';
import { registerSchema, loginSchema } from '../validators/userValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';

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

  // POST /api/users/register
  router.post('/register', validate(registerSchema), users.registerUser);

  // POST /api/users/login
  router.post('/login', validate(loginSchema), users.loginUser);

  // GET /api/users/me
  router.get('/me', requireAuth, users.getCurrentUser);

  return router;
}

export default createUserRouter;
