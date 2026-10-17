import express from 'express';
import { createAdminController } from '../controllers/adminController.js';
import { requireAdminAuth } from '../middleware/requireAdminAuth.js';

/**
 * Builds the /api/admin router.
 *
 * @param {Object} deps
 * @param {{ query: Function, connect?: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createAdminRouter({ db }) {
  const router = express.Router();
  const admin = createAdminController({ db });

  // POST /api/admin/auctions/close-expired
  router.post('/auctions/close-expired', requireAdminAuth, admin.closeExpired);

  return router;
}

export default createAdminRouter;
