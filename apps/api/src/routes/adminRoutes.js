import express from 'express';
import { createAdminController } from '../controllers/adminController.js';
import { requireAdminAuth } from '../middleware/requireAdminAuth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireRole } from '../middleware/requireRole.js';
import { validate } from '../middleware/validate.js';
import { listUsersQuerySchema } from '../validators/adminValidators.js';

/**
 * Builds the /api/admin router.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 * @param {Object} [deps.cache] - LRU cache instance.
 * @returns {import('express').Router}
 */
export function createAdminRouter({ db, cache }) {
  const router = express.Router();
  const admin = createAdminController({ db, cache });

  // POST /api/admin/auctions/close-expired (Protected by X-Admin-Token)
  router.post('/auctions/close-expired', requireAdminAuth, admin.closeExpired);

  // GET /api/admin/users (Protected by Bearer auth + requireRole('admin'))
  router.get(
    '/users',
    requireAuth,
    validate(listUsersQuerySchema, 'query'),
    requireRole('admin', { db }),
    admin.listUsers
  );

  return router;
}

export default createAdminRouter;
