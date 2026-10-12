import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, toInt } from '../middleware/auth.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';

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
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM notifications n
    WHERE n.user_id = ${req.user.id}
      AND (
        n.related_type = 'announcement'
        OR (n.related_type = 'test' AND EXISTS (
          SELECT 1 FROM tests t JOIN courses c ON c.id = t.course_id
          LEFT JOIN grand_test_groups g ON g.id = t.grand_test_id
          JOIN students st ON st.user_id = n.user_id
          WHERE t.id = n.related_id
            AND COALESCE(g.class_id, c.class_id) = st.class_id
            AND (t.section_id IS NULL OR t.section_id = st.section_id)
        ))
        OR (n.related_type = 'live_session' AND EXISTS (
          SELECT 1 FROM live_sessions s JOIN students st ON st.user_id = n.user_id
          WHERE s.id = n.related_id AND s.deleted_at IS NULL
            AND s.class_id = st.class_id
            AND (s.section_id IS NULL OR s.section_id = st.section_id)
        ))
      )
  `;
  const data = await sql`
    SELECT id, type, title, body, related_type AS "relatedType", related_id AS "relatedId",
           created_at AS "createdAt", read_at AS "readAt"
    FROM notifications n WHERE n.user_id = ${req.user.id}
      AND (
        n.related_type = 'announcement'
        OR (n.related_type = 'test' AND EXISTS (
          SELECT 1 FROM tests t JOIN courses c ON c.id = t.course_id
          LEFT JOIN grand_test_groups g ON g.id = t.grand_test_id
          JOIN students st ON st.user_id = n.user_id
          WHERE t.id = n.related_id
            AND COALESCE(g.class_id, c.class_id) = st.class_id
            AND (t.section_id IS NULL OR t.section_id = st.section_id)
        ))
        OR (n.related_type = 'live_session' AND EXISTS (
          SELECT 1 FROM live_sessions s JOIN students st ON st.user_id = n.user_id
          WHERE s.id = n.related_id AND s.deleted_at IS NULL
            AND s.class_id = st.class_id
            AND (s.section_id IS NULL OR s.section_id = st.section_id)
        ))
      )
    ORDER BY created_at DESC, id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  return res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

notificationsRouter.get('/unread-count', asyncHandler(async (req, res) => {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM notifications n
    WHERE n.user_id = ${req.user.id} AND n.read_at IS NULL
      AND (
        n.related_type = 'announcement'
        OR (n.related_type = 'test' AND EXISTS (
          SELECT 1 FROM tests t JOIN courses c ON c.id = t.course_id
          LEFT JOIN grand_test_groups g ON g.id = t.grand_test_id
          JOIN students st ON st.user_id = n.user_id
          WHERE t.id = n.related_id
            AND COALESCE(g.class_id, c.class_id) = st.class_id
            AND (t.section_id IS NULL OR t.section_id = st.section_id)
        ))
        OR (n.related_type = 'live_session' AND EXISTS (
          SELECT 1 FROM live_sessions s JOIN students st ON st.user_id = n.user_id
          WHERE s.id = n.related_id AND s.deleted_at IS NULL
            AND s.class_id = st.class_id
            AND (s.section_id IS NULL OR s.section_id = st.section_id)
        ))
      )
  `;
  return res.json({ success: true, data: { count: row.count } });
}));

notificationsRouter.patch('/:id/read', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Invalid notification.');
  const [row] = await sql`
    UPDATE notifications n SET read_at = COALESCE(n.read_at, NOW())
    WHERE n.id = ${id} AND n.user_id = ${req.user.id}
      AND (
        n.related_type = 'announcement'
        OR (n.related_type = 'test' AND EXISTS (
          SELECT 1 FROM tests t JOIN courses c ON c.id = t.course_id
          LEFT JOIN grand_test_groups g ON g.id = t.grand_test_id
          JOIN students st ON st.user_id = n.user_id
          WHERE t.id = n.related_id
            AND COALESCE(g.class_id, c.class_id) = st.class_id
            AND (t.section_id IS NULL OR t.section_id = st.section_id)
        ))
        OR (n.related_type = 'live_session' AND EXISTS (
          SELECT 1 FROM live_sessions s JOIN students st ON st.user_id = n.user_id
          WHERE s.id = n.related_id AND s.deleted_at IS NULL
            AND s.class_id = st.class_id
            AND (s.section_id IS NULL OR s.section_id = st.section_id)
        ))
      )
    RETURNING id, read_at AS "readAt"
  `;
  if (!row) return fail(res, 404, 'Notification not found.');
  return res.json({ success: true, data: row });
}));

notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  const rows = await sql`
    UPDATE notifications n SET read_at = NOW()
    WHERE n.user_id = ${req.user.id} AND n.read_at IS NULL
      AND (
        n.related_type = 'announcement'
        OR (n.related_type = 'test' AND EXISTS (
          SELECT 1 FROM tests t JOIN courses c ON c.id = t.course_id
          LEFT JOIN grand_test_groups g ON g.id = t.grand_test_id
          JOIN students st ON st.user_id = n.user_id
          WHERE t.id = n.related_id
            AND COALESCE(g.class_id, c.class_id) = st.class_id
            AND (t.section_id IS NULL OR t.section_id = st.section_id)
        ))
        OR (n.related_type = 'live_session' AND EXISTS (
          SELECT 1 FROM live_sessions s JOIN students st ON st.user_id = n.user_id
          WHERE s.id = n.related_id AND s.deleted_at IS NULL
            AND s.class_id = st.class_id
            AND (s.section_id IS NULL OR s.section_id = st.section_id)
        ))
      )
    RETURNING n.id
  `;
  return res.json({ success: true, data: { updated: rows.length } });
}));
