import express from 'express';
import { createUserController } from '../controllers/userController.js';

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
  router.post('/register', users.registerUser);

  return router;
}

export default createUserRouter;
