import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE } from '../middleware/auth.js';
import { sendPushToUsers } from '../services/pushNotifications.js';

export const announcementsRouter = express.Router();

announcementsRouter.get('/', asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT a.id, a.title, a.body, a.created_at AS "createdAt", u.full_name AS "authorName"
    FROM announcements a JOIN users u ON u.id = a.created_by
    ORDER BY a.created_at DESC LIMIT 100
  `;
  return res.json({ success: true, data });
}));

announcementsRouter.post('/', requireRole(ROLE.ADMIN, ROLE.TEACHER), asyncHandler(async (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (title.length < 3 || title.length > 120) return fail(res, 400, 'Title must be 3 to 120 characters.');
  if (!body || body.length > 5000) return fail(res, 400, 'Announcement must be 1 to 5000 characters.');

  const [created] = await sql`
    WITH created AS (
      INSERT INTO announcements (title, body, created_by)
      VALUES (${title}, ${body}, ${req.user.id})
      RETURNING id, title, body, created_at AS "createdAt"
    ), sent AS (
      INSERT INTO notifications (user_id, type, title, body, related_type, related_id, event_key)
      SELECT u.id, 'announcement', created.title, created.body, 'announcement', created.id,
             'announcement:' || created.id::text
      FROM created CROSS JOIN users u JOIN students s ON s.user_id = u.id
      WHERE u.role = ${ROLE.STUDENT} AND u.is_active = TRUE
      ON CONFLICT (user_id, event_key) DO NOTHING
      RETURNING user_id AS "userId"
    )
    SELECT created.id, created.title, created.body, created."createdAt", ${req.user.fullName} AS "authorName",
           ARRAY(SELECT "userId" FROM sent) AS "recipientIds"
    FROM created
  `;
  const { recipientIds, ...announcement } = created;
  await sendPushToUsers(recipientIds, {
    type: 'announcement',
    title: announcement.title,
    body: announcement.body,
    relatedType: 'announcement',
    relatedId: announcement.id,
  });
  return res.status(201).json({ success: true, data: announcement });
}));
