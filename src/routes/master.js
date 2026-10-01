import express from 'express';
import { sql } from '../db/connection.js';

export const masterRouter = express.Router();

masterRouter.get('/classes', async (_req, res) => {
  try {
    const classes = await sql`
      SELECT id, level, grp, name, is_active as "isActive"
      FROM classes WHERE is_active = TRUE ORDER BY level, grp
    `;
    return res.json({ success: true, data: classes });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/sections', async (_req, res) => {
  try {
    const sections = await sql`
      SELECT id, class_id as "classId", name FROM sections ORDER BY class_id, name
    `;
    return res.json({ success: true, data: sections });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/subjects', async (_req, res) => {
  try {
    const subjects = await sql`SELECT id, name FROM subjects ORDER BY name`;
    return res.json({ success: true, data: subjects });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/courses', async (_req, res) => {
  try {
    const courses = await sql`
      SELECT
        c.id,
        c.class_id as "classId",
        c.subject_id as "subjectId",
        s.name as "subjectName",
        cl.name as "className"
      FROM courses c
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE cl.is_active = TRUE
      ORDER BY cl.level, cl.grp, s.name
    `;
    return res.json({ success: true, data: courses });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
