import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sql } from '../db/connection.js';
import { config } from '../config/index.js';
import { asyncHandler, authenticate, fail, invalidateUser, ROLE } from '../middleware/auth.js';

export const authRouter = express.Router();

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;

const toUserDto = (u) => ({
  id: u.id,
  role: u.role,
  username: u.username,
  fullName: u.full_name,
  phone: u.phone,
  isActive: u.is_active,
  mustChangePw: u.must_change_pw,
});

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || typeof username !== 'string') {
    return fail(res, 400, 'Username or Roll Number is required');
  }

  const [user] = await sql`SELECT * FROM users WHERE LOWER(username) = LOWER(${username.trim()})`;
  // Same message for unknown user and wrong password so usernames can't be enumerated.
  if (!user) return fail(res, 401, 'Invalid username or password.');

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return fail(res, 429, `Too many failed attempts. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`);
  }
  if (!user.is_active) return fail(res, 403, 'Account is deactivated. Contact Admin.');

  // SECURITY FIX: the old code skipped the password check whenever `password` was empty,
  // which let anyone log in as any user (including Admin) knowing only the username.
  if (!password && !config.allowPasswordlessLogin) {
    return fail(res, 400, 'Password is required.');
  }
  if (password) {
    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) {
      const failures = (user.failed_login_count || 0) + 1;
      if (failures >= MAX_FAILURES) {
        await sql`
          UPDATE users SET failed_login_count = 0, locked_until = NOW() + (${LOCK_MINUTES} || ' minutes')::interval
          WHERE id = ${user.id}
        `;
        return fail(res, 429, `Too many failed attempts. Account locked for ${LOCK_MINUTES} minutes.`);
      }
      await sql`UPDATE users SET failed_login_count = ${failures} WHERE id = ${user.id}`;
      return fail(res, 401, 'Invalid username or password.');
    }
  }

  await sql`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ${user.id}`;

  let studentProfile;
  if (user.role === ROLE.STUDENT) {
    const [st] = await sql`
      SELECT s.*, c.name AS class_name, sec.name AS section_name
      FROM students s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      WHERE s.user_id = ${user.id}
    `;
    if (st) {
      studentProfile = {
        userId: st.user_id,
        rollNo: user.username,
        classId: st.class_id,
        className: st.class_name,
        sectionId: st.section_id,
        sectionName: st.section_name,
      };
    }
  }

  const token = jwt.sign({ id: user.id, role: user.role, username: user.username }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });

  return res.json({ success: true, data: { token, user: toUserDto(user), student: studentProfile } });
}));

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const [user] = await sql`
    SELECT id, role, username, full_name, phone, is_active, must_change_pw FROM users WHERE id = ${req.user.id}
  `;
  return res.json({ success: true, data: toUserDto(user) });
}));

// AUTH-3: temporary passwords must be changeable (this endpoint did not exist before).
authRouter.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return fail(res, 400, 'Current and new password are required.');
  if (String(newPassword).length < 8) return fail(res, 400, 'New password must be at least 8 characters.');

  const [user] = await sql`SELECT password_hash FROM users WHERE id = ${req.user.id}`;
  if (!(await bcrypt.compare(String(currentPassword), user.password_hash))) {
    return fail(res, 401, 'Current password is incorrect.');
  }

  const hash = await bcrypt.hash(String(newPassword), 10);
  await sql`UPDATE users SET password_hash = ${hash}, must_change_pw = FALSE WHERE id = ${req.user.id}`;
  invalidateUser(req.user.id);
  return res.json({ success: true });
}));