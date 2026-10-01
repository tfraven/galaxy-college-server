import express from 'express';
import { db } from '../db/connection.js';

export const masterRouter = express.Router();

masterRouter.get('/classes', (_req, res) => {
  try {
    const classes = db.prepare('SELECT id, level, grp, name, is_active as isActive FROM classes WHERE is_active = 1').all();
    return res.json({ success: true, data: classes });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/sections', (_req, res) => {
  try {
    const sections = db.prepare('SELECT id, class_id as classId, name FROM sections').all();
    return res.json({ success: true, data: sections });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/subjects', (_req, res) => {
  try {
    const subjects = db.prepare('SELECT id, name FROM subjects').all();
    return res.json({ success: true, data: subjects });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

masterRouter.get('/courses', (_req, res) => {
  try {
    const courses = db.prepare(`
      SELECT 
        c.id, 
        c.class_id as classId, 
        c.subject_id as subjectId,
        s.name as subjectName,
        cl.name as className
      FROM courses c
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE cl.is_active = 1
    `).all();
    return res.json({ success: true, data: courses });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
