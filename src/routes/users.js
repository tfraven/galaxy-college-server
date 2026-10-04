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
      UPDATE users
      SET is_active = ${isActive},
          token_version = token_version + CASE WHEN is_active IS DISTINCT FROM ${isActive} THEN 1 ELSE 0 END
      WHERE id = ${id}
      RETURNING id, is_active
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
    UPDATE users SET password_hash = ${hash}, must_change_pw = TRUE,
                     token_version = token_version + 1
    WHERE id = ${id} RETURNING id, username
    `;
    if (!row) return fail(res, 404, 'User not found');
    return res.json({ success: true, data: { id: row.id, username: row.username, tempPassword } });
}));
