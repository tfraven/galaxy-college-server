import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from '../db/connection.js';
import { config } from '../config/index.js';
import { asyncHandler, authenticate, fail, ROLE, requireRole } from '../middleware/auth.js';
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

const toStudentDto = (st, user) => st ? ({
  userId: st.user_id,
  rollNo: user.username,
  classId: st.class_id,
  className: st.class_name,
  sectionId: st.section_id,
  sectionName: st.section_name,
}) : undefined;

const signToken = (user, deviceId = null) => jwt.sign(
  { id: user.id, ver: user.token_version, ...(deviceId ? { dev: deviceId } : {}) },
  config.jwtSecret,
  { expiresIn: config.jwtExpiresIn, algorithm: 'HS256', issuer: config.jwtIssuer, audience: config.jwtAudience },
);

const validDeviceId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,128}$/.test(value);
const validRequestId = (value) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);

const studentProfileFor = async (userId) => {
  const [st] = await sql`
    SELECT s.user_id, s.class_id, s.section_id, c.name AS class_name, sec.name AS section_name
    FROM students s JOIN classes c ON s.class_id = c.id
    LEFT JOIN sections sec ON s.section_id = sec.id WHERE s.user_id = ${userId}
  `;
  return st;
};

authRouter.post('/login', asyncHandler(async (req, res) => {
  const { username, password, deviceId, deviceLabel } = req.body || {};
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
    SELECT id, role, username, password_hash, full_name, phone, is_active, must_change_pw, token_version,
           active_device_id, active_device_label
    FROM users WHERE LOWER(username) = LOWER(${username.trim()})
  `;
  // Same message for unknown user and wrong password so usernames can't be enumerated.
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    return fail(res, 401, 'Invalid username or password.');
  }

  let activeDeviceId = null;
  if (user.role === ROLE.STUDENT) {
    if (!validDeviceId(deviceId)) return fail(res, 400, 'This app needs a secure device ID. Update the app and try again.');
    const label = typeof deviceLabel === 'string' ? deviceLabel.trim().slice(0, 80) : 'Unknown device';
    const [claimed] = await sql`
      UPDATE users SET active_device_id = ${deviceId}, active_device_label = ${label || 'Student device'}, device_last_seen_at = NOW()
      WHERE id = ${user.id} AND (active_device_id IS NULL OR active_device_id = ${deviceId})
      RETURNING token_version
    `;
    if (claimed) {
      user.token_version = claimed.token_version;
      activeDeviceId = deviceId;
    } else {
      const requestId = randomUUID();
      const approvalKey = randomBytes(32).toString('hex');
      const approvalKeyHash = createHash('sha256').update(approvalKey).digest('hex');
      await sql`
        INSERT INTO device_login_requests (id, user_id, device_id, device_label, approval_key_hash, expires_at)
        VALUES (${requestId}, ${user.id}, ${deviceId}, ${label || 'Student device'}, ${approvalKeyHash}, NOW() + INTERVAL '5 minutes')
      `;
      return res.json({ success: true, data: { requiresApproval: true, requestId, approvalKey, expiresInSeconds: 300 } });
    }
  }

  const profile = user.role === ROLE.STUDENT ? await studentProfileFor(user.id) : null;
  return res.json({ success: true, data: { token: signToken(user, activeDeviceId), user: toUserDto(user), student: toStudentDto(profile, user) } });
}));

// The waiting device uses its one-time secret to check whether the logged-in device approved it.
authRouter.post('/device-login-status', asyncHandler(async (req, res) => {
  const { requestId, approvalKey } = req.body || {};
  if (!validRequestId(requestId) || typeof approvalKey !== 'string' || !/^[0-9a-f]{64}$/i.test(approvalKey)) {
    return fail(res, 400, 'Invalid device approval request.');
  }
  const keyHash = createHash('sha256').update(approvalKey).digest('hex');
  const [request] = await sql`
    UPDATE device_login_requests
    SET status = 'expired'
    WHERE id = ${requestId} AND approval_key_hash = ${keyHash} AND status = 'pending' AND expires_at <= NOW()
    RETURNING id
  `;
  const [row] = await sql`
    SELECT r.status, r.user_id, r.device_id, r.approved_token_version, u.role, u.username, u.full_name, u.phone,
           u.is_active, u.must_change_pw, u.token_version
    FROM device_login_requests r JOIN users u ON u.id = r.user_id
    WHERE r.id = ${requestId} AND r.approval_key_hash = ${keyHash}
  `;
  if (!row || !row.is_active) return fail(res, 404, 'Device approval request not found.');
  if (row.status === 'pending') return res.json({ success: true, data: { status: 'pending' } });
  if (row.status !== 'approved') return res.json({ success: true, data: { status: row.status } });
  if (row.token_version !== row.approved_token_version) return res.json({ success: true, data: { status: 'superseded' } });

  const [profile] = await sql`
    SELECT s.user_id, s.class_id, s.section_id, c.name AS class_name, sec.name AS section_name
    FROM students s JOIN classes c ON s.class_id = c.id LEFT JOIN sections sec ON s.section_id = sec.id
    WHERE s.user_id = ${row.user_id}
  `;
  const user = { ...row, id: row.user_id };
  return res.json({ success: true, data: { status: 'approved', token: signToken(user, row.device_id), user: toUserDto(user), student: toStudentDto(profile, user) } });
}));

authRouter.get('/device-login-requests/pending', authenticate, requireRole(ROLE.STUDENT), asyncHandler(async (req, res) => {
  const data = await sql`
    UPDATE device_login_requests SET status = 'expired'
    WHERE user_id = ${req.user.id} AND status = 'pending' AND expires_at <= NOW()
  `;
  const requests = await sql`
    SELECT id, device_label AS "deviceLabel", requested_at AS "requestedAt", expires_at AS "expiresAt"
    FROM device_login_requests
    WHERE user_id = ${req.user.id} AND status = 'pending' AND device_id <> ${req.user.deviceId}
    ORDER BY requested_at ASC LIMIT 10
  `;
  return res.json({ success: true, data: requests });
}));

authRouter.post('/device-login-requests/:id/decision', authenticate, requireRole(ROLE.STUDENT), asyncHandler(async (req, res) => {
  const { decision } = req.body || {};
  if (!validRequestId(req.params.id) || !['approve', 'deny'].includes(decision)) return fail(res, 400, 'Invalid decision.');

  const [updated] = await sql`
    WITH switched AS (
      UPDATE users u
      SET active_device_id = r.device_id,
          active_device_label = r.device_label,
          device_last_seen_at = NOW(),
          token_version = u.token_version + 1
      FROM device_login_requests r
      WHERE r.id = ${req.params.id} AND r.user_id = u.id
        AND r.status = 'pending' AND r.expires_at > NOW()
        AND u.id = ${req.user.id} AND u.active_device_id = ${req.user.deviceId}
        AND u.token_version = ${req.user.tokenVersion}
        AND ${decision} = 'approve'
      RETURNING u.id, u.token_version
    ), decided AS (
      UPDATE device_login_requests r
      SET status = CASE WHEN ${decision} = 'approve' THEN 'approved' ELSE 'denied' END,
          decided_at = NOW(), approved_token_version = switched.token_version
      FROM switched
      WHERE r.id = ${req.params.id} AND r.user_id = switched.id
      RETURNING r.status
    ), denied AS (
      UPDATE device_login_requests r
      SET status = 'denied', decided_at = NOW()
      WHERE r.id = ${req.params.id} AND r.user_id = ${req.user.id}
        AND r.status = 'pending' AND r.expires_at > NOW()
        AND ${decision} = 'deny'
        AND EXISTS (SELECT 1 FROM users u WHERE u.id = r.user_id AND u.active_device_id = ${req.user.deviceId} AND u.token_version = ${req.user.tokenVersion})
      RETURNING r.status
    ), superseded AS (
      UPDATE device_login_requests SET status = 'superseded', decided_at = NOW()
      WHERE user_id = ${req.user.id} AND status = 'pending' AND ${decision} = 'approve'
      RETURNING id
    )
    SELECT status FROM decided UNION ALL SELECT status FROM denied LIMIT 1
  `;
  if (!updated) return fail(res, 409, 'This request expired or was already handled.');
  return res.json({ success: true, data: { status: updated.status } });
}));

authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  if (req.user.role === ROLE.STUDENT) {
    await sql`
      UPDATE users SET active_device_id = NULL, active_device_label = NULL, device_last_seen_at = NULL,
                       token_version = token_version + 1
      WHERE id = ${req.user.id} AND active_device_id = ${req.user.deviceId} AND token_version = ${req.user.tokenVersion}
    `;
  } else {
    await sql`UPDATE users SET token_version = token_version + 1 WHERE id = ${req.user.id} AND token_version = ${req.user.tokenVersion}`;
  }
  return res.json({ success: true, data: { loggedOut: true } });
}));

authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  let [user] = await sql`
    SELECT id, role, username, full_name, phone, is_active, must_change_pw, token_version
    FROM users WHERE id = ${req.user.id}
  `;
  let token;
  if (req.user.legacyDeviceId) {
    const [claimed] = await sql`
      UPDATE users SET active_device_id = ${req.user.legacyDeviceId}, active_device_label = 'This device', device_last_seen_at = NOW()
      WHERE id = ${req.user.id} AND active_device_id IS NULL RETURNING id
    `;
    const [refreshed] = await sql`SELECT active_device_id FROM users WHERE id = ${req.user.id}`;
    if (!claimed && refreshed?.active_device_id !== req.user.legacyDeviceId) return fail(res, 401, 'This account is active on another device. Please sign in again.');
    token = signToken(user, req.user.legacyDeviceId);
  } else if (req.user.role === ROLE.STUDENT) {
    await sql`UPDATE users SET device_last_seen_at = NOW() WHERE id = ${req.user.id} AND active_device_id = ${req.user.deviceId}`;
  }
  const profile = user.role === ROLE.STUDENT ? await studentProfileFor(user.id) : null;
  return res.json({ success: true, data: { ...toUserDto(user), ...(token ? { token } : {}), student: toStudentDto(profile, user) } });
}));

// AUTH-3: temporary passwords must be changeable.
authRouter.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
    return fail(res, 400, 'Current and new password are required.');
  }
  if (newPassword.length < 12) return fail(res, 400, 'New password must be at least 12 characters.');
  if (newPassword.length > 128 || Buffer.byteLength(newPassword, 'utf8') > 72) {
    return fail(res, 400, 'New password must be 72 bytes or less.');
  }

  const [user] = await sql`SELECT password_hash, token_version FROM users WHERE id = ${req.user.id}`;
  if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
    return fail(res, 401, 'Current password is incorrect.');
  }

  const hash = await bcrypt.hash(newPassword, 10);
  const [updated] = await sql`
    UPDATE users SET password_hash = ${hash}, must_change_pw = FALSE, token_version = token_version + 1
    WHERE id = ${req.user.id} AND token_version = ${user.token_version}
    RETURNING token_version
  `;
  const token = jwt.sign({ id: req.user.id, ver: updated.token_version, ...(req.user.deviceId ? { dev: req.user.deviceId } : {}) }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
  });
  return res.json({ success: true, data: { token } });
}));
