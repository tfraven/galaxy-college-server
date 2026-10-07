import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler } from '../middleware/auth.js';

// Read-only reference data. Mounted behind authenticate.
export const masterRouter = express.Router();

masterRouter.get('/classes', asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT id, level, grp, name, is_active AS "isActive" FROM classes WHERE is_active = TRUE ORDER BY level, grp
  `;
  res.json({ success: true, data });
}));

masterRouter.get('/sections', asyncHandler(async (_req, res) => {
  const data = await sql`SELECT id, class_id AS "classId", name FROM sections ORDER BY class_id, name`;
  res.json({ success: true, data });
}));

masterRouter.get('/subjects', asyncHandler(async (_req, res) => {
  const data = await sql`SELECT id, name FROM subjects ORDER BY name`;
  res.json({ success: true, data });
}));

masterRouter.get('/courses', asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT c.id, c.class_id AS "classId", c.subject_id AS "subjectId", s.name AS "subjectName", cl.name AS "className"
    FROM courses c
    JOIN subjects s ON c.subject_id = s.id
    JOIN classes cl ON c.class_id = cl.id
    WHERE cl.is_active = TRUE
    ORDER BY cl.level, cl.grp, s.name
  `;
  res.json({ success: true, data });
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
  const { level, grp, name } = req.body || {};
  if (!level || !grp || !name?.trim()) return res.status(400).json({ success: false, error: 'Level, group, and name required' });
  const [created] = await sql`
    INSERT INTO classes (level, grp, name)
    VALUES (${level}, ${grp}, ${name.trim()})
    ON CONFLICT (level, grp) DO UPDATE SET name = EXCLUDED.name, is_active = TRUE
    RETURNING id, level, grp, name, is_active AS "isActive"
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.post('/sections', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { classId, name } = req.body || {};
  if (!classId || !name?.trim()) return res.status(400).json({ success: false, error: 'Class ID and section name required' });
  const [created] = await sql`
    INSERT INTO sections (class_id, name)
    VALUES (${classId}, ${name.trim()})
    ON CONFLICT (class_id, name) DO NOTHING
    RETURNING id, class_id AS "classId", name
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.post('/subjects', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { name } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ success: false, error: 'Subject name required' });
  const [created] = await sql`
    INSERT INTO subjects (name)
    VALUES (${name.trim()})
    ON CONFLICT (name) DO NOTHING
    RETURNING id, name
  `;
  res.status(201).json({ success: true, data: created });
}));

masterRouter.post('/courses', asyncHandler(async (req, res) => {
  if (req.user.role !== 1) return res.status(403).json({ success: false, error: 'Admin only' });
  const { classId, subjectId } = req.body || {};
  if (!classId || !subjectId) return res.status(400).json({ success: false, error: 'classId and subjectId required' });
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