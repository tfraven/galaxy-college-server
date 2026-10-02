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