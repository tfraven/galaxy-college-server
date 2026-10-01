import express from 'express';
import { db } from '../db/connection.js';

export const catalogRouter = express.Router();

catalogRouter.get('/questions', (req, res) => {
  try {
    const { courseId } = req.query;
    let query = `
      SELECT 
        id, 
        course_id as courseId, 
        topic, 
        body, 
        image, 
        opt_a as optA, 
        opt_b as optB, 
        opt_c as optC, 
        opt_d as optD, 
        correct, 
        explanation, 
        is_active as isActive, 
        created_by as createdBy, 
        created_at as createdAt
      FROM questions
      WHERE is_active = 1
    `;
    const params = [];

    if (courseId) {
      query += ' AND course_id = ?';
      params.push(parseInt(courseId, 10));
    }

    query += ' ORDER BY id DESC';

    const questions = db.prepare(query).all(...params);
    return res.json({
      success: true,
      data: questions.map((q) => ({
        ...q,
        isActive: Boolean(q.isActive),
      })),
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

catalogRouter.post('/questions', (req, res) => {
  try {
    const {
      courseId,
      topic,
      body,
      image,
      optA,
      optB,
      optC,
      optD,
      correct,
      explanation,
      createdBy = 1,
    } = req.body;

    if (!courseId || !body || !optA || !optB || !optC || !optD || !correct) {
      return res.status(400).json({ success: false, error: 'All 4 options, question body, and correct answer are required' });
    }

    const upperCorrect = correct.toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(upperCorrect)) {
      return res.status(400).json({ success: false, error: 'Correct option must be A, B, C, or D' });
    }

    const result = db.prepare(`
      INSERT INTO questions (
        course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      courseId,
      topic || null,
      body.trim(),
      image || null,
      optA.trim(),
      optB.trim(),
      optC.trim(),
      optD.trim(),
      upperCorrect,
      explanation || null,
      createdBy
    );

    const newQuestion = db.prepare(`
      SELECT 
        id, 
        course_id as courseId, 
        topic, 
        body, 
        image, 
        opt_a as optA, 
        opt_b as optB, 
        opt_c as optC, 
        opt_d as optD, 
        correct, 
        explanation, 
        is_active as isActive, 
        created_by as createdBy, 
        created_at as createdAt
      FROM questions WHERE id = ?
    `).get(result.lastInsertRowid);

    return res.status(201).json({
      success: true,
      data: {
        ...newQuestion,
        isActive: Boolean(newQuestion.isActive),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
