import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, toInt } from '../middleware/auth.js';

export const notificationsRouter = express.Router();
notificationsRouter.use(requireRole(ROLE.STUDENT));

notificationsRouter.post('/device', asyncHandler(async (req, res) => {
  const installationId = typeof req.body?.installationId === 'string' ? req.body.installationId.trim() : '';
  if (installationId.length < 10 || installationId.length > 256) return fail(res, 400, 'Invalid push installation.');
  if (!req.user.deviceId) return fail(res, 401, 'Sign in again to enable notifications on this device.');

  await sql`
    INSERT INTO push_installations (installation_id, user_id, device_id, updated_at)
    VALUES (${installationId}, ${req.user.id}, ${req.user.deviceId}, NOW())
    ON CONFLICT (installation_id) DO UPDATE
    SET user_id = EXCLUDED.user_id, device_id = EXCLUDED.device_id, updated_at = NOW()
  `;
  await sql`
    DELETE FROM push_installations
    WHERE user_id = ${req.user.id} AND device_id = ${req.user.deviceId}
      AND installation_id <> ${installationId}
  `;
  return res.json({ success: true, data: { registered: true } });
}));

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const data = await sql`
    SELECT id, type, title, body, related_type AS "relatedType", related_id AS "relatedId",
           created_at AS "createdAt", read_at AS "readAt"
    FROM notifications WHERE user_id = ${req.user.id}
    ORDER BY created_at DESC LIMIT 100
  `;
  return res.json({ success: true, data });
}));

notificationsRouter.get('/unread-count', asyncHandler(async (req, res) => {
  const [row] = await sql`SELECT COUNT(*)::int AS count FROM notifications WHERE user_id = ${req.user.id} AND read_at IS NULL`;
  return res.json({ success: true, data: { count: row.count } });
}));

notificationsRouter.patch('/:id/read', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Invalid notification.');
  const [row] = await sql`
    UPDATE notifications SET read_at = COALESCE(read_at, NOW())
    WHERE id = ${id} AND user_id = ${req.user.id}
    RETURNING id, read_at AS "readAt"
  `;
  if (!row) return fail(res, 404, 'Notification not found.');
  return res.json({ success: true, data: row });
}));

notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  const rows = await sql`UPDATE notifications SET read_at = NOW() WHERE user_id = ${req.user.id} AND read_at IS NULL RETURNING id`;
  return res.json({ success: true, data: { updated: rows.length } });
}));
