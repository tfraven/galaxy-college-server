import express from 'express';
import bcrypt from 'bcryptjs';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, toInt } from '../middleware/auth.js';
import { generateTempPassword } from '../services/security.js';

// Student management is Admin-only for writes (STU-1..9); Operators may read the list.
export const studentsRouter = express.Router();

const MAX_BULK_ROWS = 2000; // STU-9
const BULK_BCRYPT_COST = 8; // temp passwords must be changed at first login; keeps 2,000 hashes fast

studentsRouter.get('/', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT s.user_id AS "userId", u.username AS "rollNo", u.full_name AS "fullName", u.phone,
           s.class_id AS "classId", c.name AS "className",
           s.section_id AS "sectionId", sec.name AS "sectionName", u.is_active AS "isActive"
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN sections sec ON s.section_id = sec.id
    ORDER BY s.user_id ASC
  `;
  res.json({ success: true, data });
}));

studentsRouter.post('/', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const { fullName, rollNo, classId, sectionId, phone } = req.body || {};
  if (!fullName?.trim() || !rollNo?.trim() || !classId) {
    return fail(res, 400, 'Full name, roll number, and class are required');
  }

  const [cls] = await sql`SELECT name FROM classes WHERE id = ${classId} AND is_active = TRUE`;
  if (!cls) return fail(res, 400, 'Unknown class');

  let sec = null;
  if (sectionId) {
    [sec] = await sql`SELECT name FROM sections WHERE id = ${sectionId} AND class_id = ${classId}`;
    if (!sec) return fail(res, 400, 'Section does not belong to that class');
  }

  const existing = await sql`SELECT 1 FROM users WHERE LOWER(username) = LOWER(${rollNo.trim()})`;
  if (existing.length) return fail(res, 400, `Roll number "${rollNo}" already exists`);

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 10);

  // One statement = atomic: no orphan users row if the students insert fails.
  const [created] = await sql`
    WITH u AS (
      INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
      VALUES (4, ${rollNo.trim()}, ${hash}, ${fullName.trim()}, ${phone || null}, TRUE, TRUE)
      RETURNING id
    ), s AS (
      INSERT INTO students (user_id, class_id, section_id)
      SELECT id, ${classId}, ${sectionId || null} FROM u RETURNING user_id
    )
    SELECT id FROM u
  `;

  res.status(201).json({
    success: true,
    data: {
      user: { id: created.id, role: 4, username: rollNo.trim(), fullName: fullName.trim(), phone: phone || null, isActive: true, mustChangePw: true },
      student: { userId: created.id, rollNo: rollNo.trim(), classId, className: cls.name, sectionId: sectionId || null, sectionName: sec?.name ?? null },
      tempPassword, // shown once (STU-6)
    },
  });
}));

// Preview bulk upload (STU-4/5): validates every row, generates roll numbers, skips ones already taken.
studentsRouter.post('/preview-bulk', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const { prefix = 'PE1-', startNumber = 1001, padding = 4, sampleRows = [] } = req.body || {};
  if (!Array.isArray(sampleRows) || sampleRows.length > MAX_BULK_ROWS) {
    return fail(res, 400, `Provide up to ${MAX_BULK_ROWS} rows`);
  }

  const taken = new Set((await sql`SELECT LOWER(username) AS u FROM users`).map((r) => r.u));
  const classIds = new Set((await sql`SELECT id FROM classes WHERE is_active = TRUE`).map((r) => r.id));

  let n = parseInt(startNumber, 10) || 1001;
  const pad = parseInt(padding, 10) || 4;

  const previewRows = sampleRows.map((r, idx) => {
    let error;
    if (!r.fullName?.trim()) error = 'Full name missing';
    else if (!classIds.has(Number(r.classId))) error = 'Unknown class';
    else if (r.phone && !/^[0-9+\-\s]{7,20}$/.test(String(r.phone))) error = 'Bad phone number';

    let roll;
    do {
      roll = `${prefix}${String(n++).padStart(pad, '0')}`;
    } while (taken.has(roll.toLowerCase()));
    taken.add(roll.toLowerCase());

    return { rowNum: idx + 1, fullName: r.fullName, generatedRollNo: roll, classId: r.classId, sectionId: r.sectionId, phone: r.phone, valid: !error, error };
  });

  res.json({ success: true, data: { previewRows, totalValid: previewRows.filter((r) => r.valid).length } });
}));

// Commit bulk upload: ONE atomic statement for the whole batch (STU-9), not 2 queries per row.
studentsRouter.post('/commit-bulk', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body?.validRows) ? req.body.validRows : [];
  if (!rows.length) return fail(res, 400, 'No valid rows provided');
  if (rows.length > MAX_BULK_ROWS) return fail(res, 400, `Import limit is ${MAX_BULK_ROWS} rows per file`);
  if (rows.some((r) => !r.fullName?.trim() || !r.generatedRollNo || !r.classId)) {
    return fail(res, 400, 'Every row needs fullName, generatedRollNo and classId');
  }

  const credentials = [];
  const hashes = [];
  for (const r of rows) {
    const tempPass = generateTempPassword();
    credentials.push({ rollNo: r.generatedRollNo, tempPass });
    hashes.push(await bcrypt.hash(tempPass, BULK_BCRYPT_COST));
  }

  try {
    await sql`
      WITH ins AS (
        INSERT INTO users (role, username, password_hash, full_name, phone, is_active, must_change_pw)
        SELECT 4, t.username, t.hash, t.full_name, NULLIF(t.phone, ''), TRUE, TRUE
        FROM unnest(${rows.map((r) => r.generatedRollNo)}::text[], ${hashes}::text[],
                    ${rows.map((r) => r.fullName.trim())}::text[], ${rows.map((r) => r.phone || '')}::text[])
             AS t(username, hash, full_name, phone)
        RETURNING id, username
      )
      INSERT INTO students (user_id, class_id, section_id)
      SELECT ins.id, t.class_id, t.section_id
      FROM ins JOIN unnest(${rows.map((r) => r.generatedRollNo)}::text[], ${rows.map((r) => Number(r.classId))}::int[],
                           ${rows.map((r) => (r.sectionId ? Number(r.sectionId) : null))}::int[])
           AS t(username, class_id, section_id) ON t.username = ins.username
    `;
  } catch (err) {
    if (err.code === '23505') return fail(res, 409, 'A roll number was taken in the meantime. Run the preview again.');
    throw err;
  }

  res.json({ success: true, data: { importedCount: rows.length, credentials } });
}));

studentsRouter.put('/:id', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const { fullName, phone, classId, sectionId } = req.body || {};
  if (id === null) return fail(res, 400, 'Invalid student id');

  if (fullName !== undefined) {
    await sql`UPDATE users SET full_name = ${fullName.trim()}, phone = ${phone || null} WHERE id = ${id}`;
  }
  if (classId) {
    await sql`
      UPDATE students
      SET class_id = ${classId},
          section_id = ${sectionId ? toInt(sectionId) : null}
      WHERE user_id = ${id}
    `;
  }

  const [student] = await sql`
    SELECT s.user_id AS "userId", u.username AS "rollNo", u.full_name AS "fullName", u.phone,
           s.class_id AS "classId", c.name AS "className",
           s.section_id AS "sectionId", sec.name AS "sectionName", u.is_active AS "isActive"
    FROM students s
    JOIN users u ON s.user_id = u.id
    JOIN classes c ON s.class_id = c.id
    LEFT JOIN sections sec ON s.section_id = sec.id
    WHERE s.user_id = ${id}
  `;
  if (!student) return fail(res, 404, 'Student not found');
  res.json({ success: true, data: student });
}));

studentsRouter.delete('/:id', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (id === null) return fail(res, 400, 'Invalid student id');
  await sql`UPDATE users SET is_active = FALSE WHERE id = ${id}`;
  res.json({ success: true, data: { id, deleted: true } });
}));