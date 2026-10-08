import express from 'express';
import bcrypt from 'bcryptjs';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, toInt } from '../middleware/auth.js';
import { generateTempPassword } from '../services/security.js';

// AUTH-4: Admin can reset any password and activate/deactivate accounts. Mounted behind authenticate.
export const usersRouter = express.Router();
usersRouter.use(requireRole(ROLE.ADMIN));

usersRouter.patch('/:id/active', asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    const { isActive } = req.body || {};
    if (id === null || typeof isActive !== 'boolean') return fail(res, 400, 'isActive (boolean) is required');
    if (id === req.user.id && !isActive) return fail(res, 400, 'You cannot deactivate your own account.');

    const [row] = await sql`
      WITH changed AS (
        UPDATE users
        SET is_active = ${isActive},
            active_device_id = CASE WHEN ${isActive} THEN active_device_id ELSE NULL END,
            active_device_label = CASE WHEN ${isActive} THEN active_device_label ELSE NULL END,
            device_last_seen_at = CASE WHEN ${isActive} THEN device_last_seen_at ELSE NULL END,
            token_version = token_version + CASE WHEN is_active IS DISTINCT FROM ${isActive} THEN 1 ELSE 0 END
        WHERE id = ${id}
        RETURNING id, is_active
      ), cancelled AS (
        UPDATE device_login_requests SET status = 'superseded', decided_at = NOW()
        WHERE user_id = (SELECT id FROM changed) AND status = 'pending'
          AND (SELECT is_active FROM changed) = FALSE
        RETURNING id
      )
      SELECT id, is_active FROM changed
    `;
    if (!row) return fail(res, 404, 'User not found');
    return res.json({ success: true, data: { id: row.id, isActive: row.is_active } });
}));

usersRouter.post('/:id/reset-password', asyncHandler(async (req, res) => {
    const id = toInt(req.params.id);
    if (id === null) return fail(res, 400, 'Invalid user id');
    const tempPassword = generateTempPassword();
    const hash = await bcrypt.hash(tempPassword, 10);
    const [row] = await sql`
      WITH changed AS (
        UPDATE users SET password_hash = ${hash}, must_change_pw = TRUE,
                         active_device_id = NULL, active_device_label = NULL, device_last_seen_at = NULL,
                         token_version = token_version + 1
        WHERE id = ${id} RETURNING id, username
      ), cancelled AS (
        UPDATE device_login_requests SET status = 'superseded', decided_at = NOW()
        WHERE user_id = (SELECT id FROM changed) AND status = 'pending'
        RETURNING id
      )
      SELECT id, username FROM changed
    `;
    if (!row) return fail(res, 404, 'User not found');
    return res.json({ success: true, data: { id: row.id, username: row.username, tempPassword } });
}));
