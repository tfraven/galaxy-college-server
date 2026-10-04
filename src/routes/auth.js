import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sql } from '../db/connection.js';
import { config } from '../config/index.js';
import { asyncHandler, authenticate, fail, ROLE } from '../middleware/auth.js';
import { consumeLoginRateLimit } from '../services/loginRateLimit.js';

export const authRouter = express.Router();

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
  if (typeof username !== 'string' || !username.trim() || username.trim().length > 128) {
    return fail(res, 400, 'Enter a valid username or Roll Number.');
  }
  if (typeof password !== 'string' || !password || password.length > 128 || Buffer.byteLength(password, 'utf8') > 72) {
    return fail(res, 400, 'Enter a valid password.');
  }

  const rateLimit = await consumeLoginRateLimit(req.ip || req.socket.remoteAddress);
  res.setHeader('RateLimit-Limit', String(rateLimit.limit));
  res.setHeader('RateLimit-Remaining', String(rateLimit.remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil(Date.now() / 1000) + rateLimit.retryAfterSeconds));
  if (rateLimit.limited) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    return fail(res, 429, 'Too many login attempts. Try again later.');
  }

  const [user] = await sql`
    SELECT id, role, username, password_hash, full_name, phone, is_active, must_change_pw, token_version
    FROM users WHERE LOWER(username) = LOWER(${username.trim()})
  `;
  // Same message for unknown user and wrong password so usernames can't be enumerated.
  if (!user) return fail(res, 401, 'Invalid username or password.');
  if (!user.is_active) return fail(res, 401, 'Invalid username or password.');

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return fail(res, 401, 'Invalid username or password.');
  }

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

  const token = jwt.sign({ id: user.id, ver: user.token_version }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
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
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
    return fail(res, 400, 'Current and new password are required.');
  }
  if (newPassword.length < 12) return fail(res, 400, 'New password must be at least 12 characters.');
  if (newPassword.length > 128 || Buffer.byteLength(newPassword, 'utf8') > 72) {
    return fail(res, 400, 'New password must be 72 bytes or less.');
  }

  const [user] = await sql`SELECT password_hash FROM users WHERE id = ${req.user.id}`;
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return fail(res, 401, 'Current password is incorrect.');
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const [updated] = await sql`
    UPDATE users
    SET password_hash = ${hash}, must_change_pw = FALSE, token_version = token_version + 1
    WHERE id = ${req.user.id}
    RETURNING token_version
  `;
  const token = jwt.sign({ id: req.user.id, ver: updated.token_version }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  return res.json({ success: true, data: { token } });
}));
