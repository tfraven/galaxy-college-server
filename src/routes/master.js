import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler } from '../middleware/auth.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';

// Read-only reference data. Mounted behind authenticate.
export const masterRouter = express.Router();

const positiveInt = (value) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

masterRouter.get('/classes', asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM classes WHERE is_active = TRUE`;
  const data = await sql`
    SELECT id, level, grp, name, is_active AS "isActive" FROM classes WHERE is_active = TRUE
    ORDER BY level, grp LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

masterRouter.get('/sections', asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM sections s
    JOIN classes c ON c.id = s.class_id
    WHERE s.is_active = TRUE AND c.is_active = TRUE
  `;
  const data = await sql`
    SELECT s.id, s.class_id AS "classId", c.name AS "className", s.name
    FROM sections s JOIN classes c ON c.id = s.class_id
    WHERE s.is_active = TRUE AND c.is_active = TRUE
    ORDER BY c.level, c.grp, s.name LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

masterRouter.get('/subjects', asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM subjects WHERE is_active = TRUE`;
  const data = await sql`SELECT id, name FROM subjects WHERE is_active = TRUE ORDER BY name LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}`;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

masterRouter.get('/courses', asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM courses c
    JOIN classes cl ON cl.id = c.class_id
    JOIN subjects s ON s.id = c.subject_id
    WHERE cl.is_active = TRUE AND s.is_active = TRUE
  `;
  const data = await sql`
    SELECT c.id, c.class_id AS "classId", c.subject_id AS "subjectId", s.name AS "subjectName", cl.name AS "className"
    FROM courses c
    JOIN subjects s ON c.subject_id = s.id
    JOIN classes cl ON c.class_id = cl.id
    WHERE cl.is_active = TRUE AND s.is_active = TRUE
    ORDER BY cl.level, cl.grp, s.name LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

// Admin & Staff Dashboard Metrics
masterRouter.get('/stats', asyncHandler(async (req, res) => {
  const [counts] = await sql`
    SELECT
      (SELECT COUNT(*)::int FROM students) AS students,
      (SELECT COUNT(*)::int FROM users WHERE role = 3) AS teachers,
      (SELECT COUNT(*)::int FROM users WHERE role = 2) AS operators,
      (SELECT COUNT(*)::int FROM classes WHERE is_active = TRUE) AS classes,
      (SELECT COUNT(*)::int FROM courses) AS courses,
      (SELECT COUNT(*)::int FROM questions WHERE is_active = TRUE) AS questions,
      (SELECT COUNT(*)::int FROM tests) AS tests,
      (SELECT COUNT(*)::int FROM attempts) AS attempts,
      (SELECT COUNT(*)::int FROM live_sessions) AS sessions,
      (SELECT COUNT(*)::int FROM live_sessions WHERE status = 2) AS active_sessions
  `;

  const recentAttempts = await sql`
    SELECT a.id, a.test_id AS "testId", a.student_id AS "studentId",
           a.score, a.submitted_at AS "submittedAt",
           u.full_name AS "studentName", u.username AS "rollNo",
           t.title AS "testTitle"
    FROM attempts a
    JOIN users u ON a.student_id = u.id
    JOIN tests t ON a.test_id = t.id
    WHERE a.submitted_at IS NOT NULL
    ORDER BY a.submitted_at DESC
    LIMIT 6
  `;

  res.json({
    success: true,
    data: {
      counts,
      recentAttempts,
    },
  });
}));

// Admin-only creation endpoints for curriculum master data
masterRouter.post('/classes', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const level = positiveInt(req.body?.level);
  const grp = positiveInt(req.body?.grp);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!level || !grp || !name) return res.status(400).json({ success: false, error: 'Level, group, and name required' });
  if (level > 3 || grp > 3) return res.status(400).json({ success: false, error: 'Choose a valid academic level and group' });
  const [existing] = await sql`SELECT id, is_active AS "isActive" FROM classes WHERE level = ${level} AND grp = ${grp}`;
  if (existing?.isActive) return res.status(409).json({ success: false, error: 'A class already exists for that year and group. Edit it from Curriculum to change its details.' });
  const [created] = existing
    ? await sql`
        UPDATE classes SET name = ${name}, is_active = TRUE WHERE id = ${existing.id}
        RETURNING id, level, grp, name, is_active AS "isActive"
      `
    : await sql`
        INSERT INTO classes (level, grp, name) VALUES (${level}, ${grp}, ${name})
        RETURNING id, level, grp, name, is_active AS "isActive"
      `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.put('/classes/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  const level = positiveInt(req.body?.level);
  const grp = positiveInt(req.body?.grp);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!id || !level || !grp || !name) return res.status(400).json({ success: false, error: 'Class, level, group, and name are required' });
  if (level > 3 || grp > 3) return res.status(400).json({ success: false, error: 'Choose a valid academic level and group' });

  const [duplicate] = await sql`SELECT id FROM classes WHERE level = ${level} AND grp = ${grp} AND id <> ${id}`;
  if (duplicate) return res.status(409).json({ success: false, error: 'Another class already uses this year and group' });
  const [updated] = await sql`
    UPDATE classes SET level = ${level}, grp = ${grp}, name = ${name}
    WHERE id = ${id} AND is_active = TRUE
    RETURNING id, level, grp, name, is_active AS "isActive"
  `;
  if (!updated) return res.status(404).json({ success: false, error: 'Class not found' });
  res.json({ success: true, data: updated });
}));

masterRouter.delete('/classes/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid class id' });
  const [archived] = await sql`
    UPDATE classes SET is_active = FALSE WHERE id = ${id} AND is_active = TRUE
    RETURNING id
  `;
  if (!archived) return res.status(404).json({ success: false, error: 'Class not found' });
  res.json({ success: true, message: 'Class removed from the active curriculum. Existing records are preserved.' });
}));

masterRouter.post('/sections', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { classId, name } = req.body || {};
  if (!classId || !name?.trim()) return res.status(400).json({ success: false, error: 'Class ID and section name required' });
  const [created] = await sql`
    INSERT INTO sections (class_id, name)
    VALUES (${classId}, ${name.trim()})
    ON CONFLICT (class_id, name) DO UPDATE SET is_active = TRUE
    RETURNING id, class_id AS "classId", name
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.put('/sections/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  const classId = positiveInt(req.body?.classId);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!id || !classId || !name) return res.status(400).json({ success: false, error: 'Parent class and section name are required' });
  const [parent] = await sql`SELECT id FROM classes WHERE id = ${classId} AND is_active = TRUE`;
  if (!parent) return res.status(400).json({ success: false, error: 'Choose an active class' });
  const [current] = await sql`SELECT class_id FROM sections WHERE id = ${id} AND is_active = TRUE`;
  if (!current) return res.status(404).json({ success: false, error: 'Section not found' });
  if (current.class_id !== classId) {
    const [hasLinkedRecords] = await sql`
      SELECT (
        EXISTS (SELECT 1 FROM students WHERE section_id = ${id}) OR
        EXISTS (SELECT 1 FROM tests WHERE section_id = ${id}) OR
        EXISTS (SELECT 1 FROM live_sessions WHERE section_id = ${id}) OR
        EXISTS (SELECT 1 FROM recurring_live_schedules WHERE section_id = ${id})
      ) AS used
    `;
    if (hasLinkedRecords.used) {
      return res.status(409).json({ success: false, error: 'This section has linked students or sessions. Rename it, or create a new section for the other class.' });
    }
  }
  const [duplicate] = await sql`SELECT id FROM sections WHERE class_id = ${classId} AND LOWER(name) = LOWER(${name}) AND id <> ${id}`;
  if (duplicate) return res.status(409).json({ success: false, error: 'That section already exists for this class' });
  const [updated] = await sql`
    UPDATE sections SET class_id = ${classId}, name = ${name}
    WHERE id = ${id} AND is_active = TRUE
    RETURNING id, class_id AS "classId", name
  `;
  if (!updated) return res.status(404).json({ success: false, error: 'Section not found' });
  const [classRow] = await sql`SELECT name FROM classes WHERE id = ${classId}`;
  res.json({ success: true, data: { ...updated, className: classRow.name } });
}));

masterRouter.delete('/sections/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid section id' });
  const [archived] = await sql`
    UPDATE sections SET is_active = FALSE WHERE id = ${id} AND is_active = TRUE
    RETURNING id
  `;
  if (!archived) return res.status(404).json({ success: false, error: 'Section not found' });
  res.json({ success: true, message: 'Section removed from the active curriculum. Existing records are preserved.' });
}));

masterRouter.post('/subjects', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ success: false, error: 'Subject name required' });
  const [created] = await sql`
    INSERT INTO subjects (name)
    VALUES (${name.trim()})
    ON CONFLICT (name) DO UPDATE SET is_active = TRUE
    RETURNING id, name
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.put('/subjects/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!id || !name) return res.status(400).json({ success: false, error: 'Subject name is required' });
  const [duplicate] = await sql`SELECT id FROM subjects WHERE LOWER(name) = LOWER(${name}) AND id <> ${id}`;
  if (duplicate) return res.status(409).json({ success: false, error: 'A subject with that name already exists' });
  const [updated] = await sql`
    UPDATE subjects SET name = ${name} WHERE id = ${id} AND is_active = TRUE
    RETURNING id, name
  `;
  if (!updated) return res.status(404).json({ success: false, error: 'Subject not found' });
  res.json({ success: true, data: updated });
}));

masterRouter.delete('/subjects/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = positiveInt(req.params.id);
  if (!id) return res.status(400).json({ success: false, error: 'Invalid subject id' });
  const [archived] = await sql`
    UPDATE subjects SET is_active = FALSE WHERE id = ${id} AND is_active = TRUE
    RETURNING id
  `;
  if (!archived) return res.status(404).json({ success: false, error: 'Subject not found' });
  res.json({ success: true, message: 'Subject removed from the active curriculum. Existing records are preserved.' });
}));

masterRouter.post('/courses', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { classId, subjectId } = req.body || {};
  if (!classId || !subjectId) return res.status(400).json({ success: false, error: 'classId and subjectId required' });
  const [activePair] = await sql`
    SELECT cl.id FROM classes cl CROSS JOIN subjects s
    WHERE cl.id = ${classId} AND cl.is_active = TRUE AND s.id = ${subjectId} AND s.is_active = TRUE
  `;
  if (!activePair) return res.status(400).json({ success: false, error: 'Choose an active class and subject' });
  const [created] = await sql`
    INSERT INTO courses (class_id, subject_id)
    VALUES (${classId}, ${subjectId})
    ON CONFLICT (class_id, subject_id) DO NOTHING
    RETURNING id, class_id AS "classId", subject_id AS "subjectId"
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.delete('/courses/:id', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  await sql`DELETE FROM courses WHERE id = ${id}`;
  res.json({ success: true });
}));
