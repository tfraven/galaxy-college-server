import express from 'express';
import bcrypt from 'bcryptjs';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, toInt } from '../middleware/auth.js';
import { generateTempPassword } from '../services/security.js';

// Admin only (STF-1). Mounted behind authenticate.
export const staffRouter = express.Router();
staffRouter.use(requireRole(ROLE.ADMIN));

staffRouter.get('/', asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT id, role, username, full_name AS "fullName", phone,
           is_active AS "isActive", must_change_pw AS "mustChangePw"
    FROM users WHERE role IN (2, 3) ORDER BY id ASC
  `;
  res.json({ success: true, data });
}));

staffRouter.post('/', asyncHandler(async (req, res) => {
  const { role, username, fullName, phone } = req.body || {};
  if (!username?.trim() || !fullName?.trim()) return fail(res, 400, 'Full name and username are required');

  const finalRole = role === undefined ? ROLE.TEACHER : toInt(role);
  if (![ROLE.OPERATOR, ROLE.TEACHER].includes(finalRole)) return fail(res, 400, 'Role must be Operator (2) or Teacher (3)');

  const existing = await sql`SELECT 1 FROM users WHERE LOWER(username) = LOWER(${username.trim()})`;
  if (existing.length) return fail(res, 400, 'Username already in use');

  // Random one-time password instead of the guessable shared "staff123".
  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);

  const [u] = await sql`
    INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
    VALUES (${finalRole}, ${username.trim()}, ${hash}, ${fullName.trim()}, ${phone || null}, TRUE, TRUE)
    RETURNING id
  `;

  res.status(201).json({
    success: true,
    data: {
      id: u.id, role: finalRole, username: username.trim(), fullName: fullName.trim(),
      phone: phone || null, isActive: true, mustChangePw: true,
      tempPassword, // shown once
    },
  });
}));

// MD-3: assign teachers to courses (no endpoint existed, so teachers could never get scoped access).
staffRouter.get('/:id/courses', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const rows = await sql`SELECT course_id FROM teacher_courses WHERE user_id = ${id} ORDER BY course_id`;
  res.json({ success: true, data: rows.map((r) => r.course_id) });
}));

staffRouter.put('/:id/courses', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const courseIds = Array.isArray(req.body?.courseIds) ? req.body.courseIds.map(toInt).filter((n) => n !== null) : null;
  if (id === null || !courseIds) return fail(res, 400, 'courseIds array is required');

  const [teacher] = await sql`SELECT id FROM users WHERE id = ${id} AND role = 3`;
  if (!teacher) return fail(res, 404, 'Teacher not found');

  await sql.transaction([
    sql`DELETE FROM teacher_courses WHERE user_id = ${id}`,
    sql`
      INSERT INTO teacher_courses (user_id, course_id)
      SELECT ${id}, c.id FROM courses c WHERE c.id = ANY(${courseIds}::int[])
    `,
  ]);
  res.json({ success: true });
}));

staffRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const { fullName, phone, role } = req.body || {};
  if (id === null) return fail(res, 400, 'Invalid staff id');

  const updates = [];
  if (fullName?.trim()) {
    await sql`UPDATE users SET full_name = ${fullName.trim()} WHERE id = ${id}`;
  }
  if (phone !== undefined) {
    await sql`UPDATE users SET phone = ${phone || null} WHERE id = ${id}`;
  }
  if (role && [2, 3].includes(toInt(role))) {
    await sql`UPDATE users SET role = ${toInt(role)} WHERE id = ${id}`;
  }

  const [u] = await sql`
    SELECT id, role, username, full_name AS "fullName", phone,
           is_active AS "isActive", must_change_pw AS "mustChangePw"
    FROM users WHERE id = ${id}
  `;
  if (!u) return fail(res, 404, 'Staff member not found');
  res.json({ success: true, data: u });
}));

staffRouter.delete('/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (id === null) return fail(res, 400, 'Invalid staff id');
  if (id === req.user.id) return fail(res, 400, 'Cannot deactivate yourself');
  await sql`UPDATE users SET is_active = FALSE WHERE id = ${id}`;
  res.json({ success: true, data: { id, deleted: true } });
}));