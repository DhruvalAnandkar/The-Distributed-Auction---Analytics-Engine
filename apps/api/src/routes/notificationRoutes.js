import express from 'express';
import { createNotificationController } from '../controllers/notificationController.js';
import { validate } from '../middleware/validate.js';
import {
  notificationsQuerySchema,
  notificationIdParamSchema,
} from '../validators/notificationValidators.js';
import { requireAuth } from '../middleware/requireAuth.js';

/**
 * Builds the /api/users/me/notifications router.
 *
 * @param {Object} deps
 * @param {{ query: Function }} deps.db - node-postgres compatible query interface.
 * @returns {import('express').Router}
 */
export function createNotificationRouter({ db }) {
  const router = express.Router({ mergeParams: true });
  const notifications = createNotificationController({ db });

  // GET /api/users/me/notifications
  router.get(
    '/',
    requireAuth,
    validate(notificationsQuerySchema, 'query'),
    notifications.getNotifications
  );

  // POST /api/users/me/notifications/:id/read
  router.post(
    '/:id/read',
    requireAuth,
    validate(notificationIdParamSchema, 'params'),
    notifications.markAsRead
  );

  return router;
}

export default createNotificationRouter;
