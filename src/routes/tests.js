import express from 'express';
import { sql } from '../db/connection.js';

export const testsRouter = express.Router();

const buildTestDto = (t, questionIds) => ({
  id: t.id,
  courseId: t.course_id,
  courseName: `${t.subjectname} (${t.classname})`,
  sectionId: t.section_id,
  sectionName: t.sectionname || 'All Sections',
  title: t.title,
  durationMin: t.duration_min,
  markPerQ: parseFloat(t.mark_per_q),
  negMark: parseFloat(t.neg_mark),
  shuffleQ: t.shuffle_q,
  shuffleOpt: t.shuffle_opt,
  startAt: t.start_at,
  endAt: t.end_at,
  resultMode: t.result_mode,
  resultsReleased: t.results_released,
  status: t.status,
  questionIds,
  createdBy: t.created_by,
  createdAt: t.created_at,
});

testsRouter.get('/', async (_req, res) => {
  try {
    const rawTests = await sql`
      SELECT
        t.id, t.course_id, t.section_id, t.title,
        t.duration_min, t.mark_per_q, t.neg_mark,
        t.shuffle_q, t.shuffle_opt,
        t.start_at, t.end_at,
        t.result_mode, t.results_released, t.status,
        t.created_by, t.created_at,
        s.name as subjectName,
        cl.name as className,
        sec.name as sectionName
      FROM tests t
      JOIN courses c ON t.course_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      LEFT JOIN sections sec ON t.section_id = sec.id
      ORDER BY t.id DESC
    `;

    const tests = await Promise.all(
      rawTests.map(async (t) => {
        const qRows = await sql`
          SELECT question_id FROM test_questions WHERE test_id = ${t.id} ORDER BY question_id ASC
        `;
        return buildTestDto(t, qRows.map((q) => q.question_id));
      })
    );

    return res.json({ success: true, data: tests });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.get('/:id', async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const rows = await sql`
      SELECT
        t.id, t.course_id, t.section_id, t.title,
        t.duration_min, t.mark_per_q, t.neg_mark,
        t.shuffle_q, t.shuffle_opt,
        t.start_at, t.end_at,
        t.result_mode, t.results_released, t.status,
        t.created_by, t.created_at,
        s.name as subjectName,
        cl.name as className
      FROM tests t
      JOIN courses c ON t.course_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE t.id = ${testId}
    `;

    if (!rows.length) {
      return res.status(404).json({ success: false, error: 'Test not found' });
    }

    const testRow = rows[0];
    const questions = await sql`
      SELECT
        q.id, q.course_id as "courseId", q.topic, q.body, q.image,
        q.opt_a as "optA", q.opt_b as "optB", q.opt_c as "optC", q.opt_d as "optD",
        q.correct, q.explanation, q.is_active as "isActive"
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ${testId}
      ORDER BY q.id ASC
    `;

    const testDto = buildTestDto(testRow, questions.map((q) => q.id));
    return res.json({ success: true, data: { test: testDto, questions } });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.post('/', async (req, res) => {
  try {
    const {
      courseId, sectionId, title,
      durationMin = 15, markPerQ = 1, negMark = 0,
      shuffleQ = true, shuffleOpt = true,
      startAt, endAt,
      resultMode = 1, resultsReleased = true,
      status = 1, questionIds = [], createdBy = 1,
    } = req.body;

    if (!courseId || !title || !questionIds.length) {
      return res.status(400).json({ success: false, error: 'Course, title, and at least 1 question are required' });
    }

    const now = new Date();
    const finalStart = startAt || now.toISOString();
    const finalEnd = endAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const [newTest] = await sql`
      INSERT INTO tests (
        course_id, section_id, title, duration_min, mark_per_q, neg_mark,
        shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released,
        status, created_by
      ) VALUES (
        ${courseId}, ${sectionId || null}, ${title.trim()}, ${durationMin},
        ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
        ${finalStart}, ${finalEnd}, ${resultMode}, ${resultsReleased}, ${status}, ${createdBy}
      )
      RETURNING id, created_at
    `;

    const testId = newTest.id;
    for (const qid of questionIds) {
      await sql`INSERT INTO test_questions (test_id, question_id) VALUES (${testId}, ${qid})`;
    }

    const crsRows = await sql`
      SELECT s.name as "subjectName", cl.name as "className"
      FROM courses c
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE c.id = ${courseId}
    `;
    const crs = crsRows[0];

    return res.status(201).json({
      success: true,
      data: {
        id: testId,
        courseId,
        courseName: crs ? `${crs.subjectName} (${crs.className})` : 'Course Test',
        sectionId: sectionId || null,
        sectionName: 'All Sections',
        title: title.trim(),
        durationMin,
        markPerQ,
        negMark,
        shuffleQ,
        shuffleOpt,
        startAt: finalStart,
        endAt: finalEnd,
        resultMode,
        resultsReleased,
        status,
        questionIds,
        createdBy,
        createdAt: newTest.created_at,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.patch('/:id/status', async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    await sql`UPDATE tests SET status = ${status} WHERE id = ${testId}`;

    const rows = await sql`SELECT * FROM tests WHERE id = ${testId}`;
    if (!rows.length) return res.status(404).json({ success: false, error: 'Test not found' });

    const qRows = await sql`SELECT question_id FROM test_questions WHERE test_id = ${testId}`;

    return res.json({
      success: true,
      data: { ...rows[0], status, questionIds: qRows.map((q) => q.question_id) },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TST-10: Generate Question Paper & Answer Key
testsRouter.get('/:id/document', async (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const testRows = await sql`SELECT * FROM tests WHERE id = ${testId}`;
    if (!testRows.length) return res.status(404).json({ success: false, error: 'Test not found' });
    const test = testRows[0];

    const questions = await sql`
      SELECT q.id, q.body, q.topic, q.correct, q.opt_a, q.opt_b, q.opt_c, q.opt_d
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ${testId}
      ORDER BY q.id ASC
    `;

    const answerKey = questions.map((q, idx) => ({
      qNum: idx + 1,
      correct: q.correct,
      topic: q.topic,
    }));

    return res.json({
      success: true,
      data: {
        paperTitle: `${test.title} (Question Paper)`,
        totalQuestions: questions.length,
        totalMarks: questions.length * (parseFloat(test.mark_per_q) || 1),
        formattedPaper: `Generated printable test sheet with ${questions.length} questions. Ready for PDF download.`,
        answerKey,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
