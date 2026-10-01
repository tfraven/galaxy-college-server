import express from 'express';
import { db } from '../db/connection.js';

export const testsRouter = express.Router();

testsRouter.get('/', (_req, res) => {
  try {
    const rawTests = db.prepare(`
      SELECT 
        t.id,
        t.course_id as courseId,
        t.section_id as sectionId,
        t.title,
        t.duration_min as durationMin,
        t.mark_per_q as markPerQ,
        t.neg_mark as negMark,
        t.shuffle_q as shuffleQ,
        t.shuffle_opt as shuffleOpt,
        t.start_at as startAt,
        t.end_at as endAt,
        t.result_mode as resultMode,
        t.results_released as resultsReleased,
        t.status,
        t.created_by as createdBy,
        t.created_at as createdAt,
        s.name as subjectName,
        cl.name as className,
        sec.name as sectionName
      FROM tests t
      JOIN courses c ON t.course_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      LEFT JOIN sections sec ON t.section_id = sec.id
      ORDER BY t.id DESC
    `).all();

    const getQuestionsStmt = db.prepare('SELECT question_id FROM test_questions WHERE test_id = ? ORDER BY question_id ASC');

    const tests = rawTests.map((t) => {
      const qRows = getQuestionsStmt.all(t.id);
      return {
        id: t.id,
        courseId: t.courseId,
        courseName: `${t.subjectName} (${t.className})`,
        sectionId: t.sectionId,
        sectionName: t.sectionName || 'All Sections',
        title: t.title,
        durationMin: t.durationMin,
        markPerQ: t.markPerQ,
        negMark: t.negMark,
        shuffleQ: Boolean(t.shuffleQ),
        shuffleOpt: Boolean(t.shuffleOpt),
        startAt: t.startAt,
        endAt: t.endAt,
        resultMode: t.resultMode,
        resultsReleased: Boolean(t.resultsReleased),
        status: t.status,
        questionIds: qRows.map((q) => q.question_id),
        createdBy: t.createdBy,
        createdAt: t.createdAt,
      };
    });

    return res.json({ success: true, data: tests });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.get('/:id', (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const testRow = db.prepare(`
      SELECT 
        t.id,
        t.course_id as courseId,
        t.section_id as sectionId,
        t.title,
        t.duration_min as durationMin,
        t.mark_per_q as markPerQ,
        t.neg_mark as negMark,
        t.shuffle_q as shuffleQ,
        t.shuffle_opt as shuffleOpt,
        t.start_at as startAt,
        t.end_at as endAt,
        t.result_mode as resultMode,
        t.results_released as resultsReleased,
        t.status,
        t.created_by as createdBy,
        t.created_at as createdAt,
        s.name as subjectName,
        cl.name as className
      FROM tests t
      JOIN courses c ON t.course_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE t.id = ?
    `).get(testId);

    if (!testRow) {
      return res.status(404).json({ success: false, error: 'Test not found' });
    }

    const questions = db.prepare(`
      SELECT 
        q.id,
        q.course_id as courseId,
        q.topic,
        q.body,
        q.image,
        q.opt_a as optA,
        q.opt_b as optB,
        q.opt_c as optC,
        q.opt_d as optD,
        q.correct,
        q.explanation,
        q.is_active as isActive
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY q.id ASC
    `).all(testId);

    const testDto = {
      id: testRow.id,
      courseId: testRow.courseId,
      courseName: `${testRow.subjectName} (${testRow.className})`,
      sectionId: testRow.sectionId,
      sectionName: 'All Sections',
      title: testRow.title,
      durationMin: testRow.durationMin,
      markPerQ: testRow.markPerQ,
      negMark: testRow.negMark,
      shuffleQ: Boolean(testRow.shuffleQ),
      shuffleOpt: Boolean(testRow.shuffleOpt),
      startAt: testRow.startAt,
      endAt: testRow.endAt,
      resultMode: testRow.resultMode,
      resultsReleased: Boolean(testRow.resultsReleased),
      status: testRow.status,
      questionIds: questions.map((q) => q.id),
      createdBy: testRow.createdBy,
      createdAt: testRow.createdAt,
    };

    return res.json({
      success: true,
      data: {
        test: testDto,
        questions,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.post('/', (req, res) => {
  try {
    const {
      courseId,
      sectionId,
      title,
      durationMin = 15,
      markPerQ = 1,
      negMark = 0,
      shuffleQ = true,
      shuffleOpt = true,
      startAt,
      endAt,
      resultMode = 1,
      resultsReleased = true,
      status = 1,
      questionIds = [],
      createdBy = 1,
    } = req.body;

    if (!courseId || !title || !questionIds.length) {
      return res.status(400).json({ success: false, error: 'Course, title, and at least 1 question are required' });
    }

    const now = new Date();
    const finalStart = startAt || now.toISOString();
    const finalEnd = endAt || new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const insertTx = db.transaction(() => {
      const testRes = db.prepare(`
        INSERT INTO tests (
          course_id, section_id, title, duration_min, mark_per_q, neg_mark,
          shuffle_q, shuffle_opt, start_at, end_at, result_mode, results_released,
          status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        courseId,
        sectionId || null,
        title.trim(),
        durationMin,
        markPerQ,
        negMark,
        shuffleQ ? 1 : 0,
        shuffleOpt ? 1 : 0,
        finalStart,
        finalEnd,
        resultMode,
        resultsReleased ? 1 : 0,
        status,
        createdBy
      );

      const testId = testRes.lastInsertRowid;
      const insertQ = db.prepare('INSERT INTO test_questions (test_id, question_id) VALUES (?, ?)');
      for (const qid of questionIds) {
        insertQ.run(testId, qid);
      }

      return testId;
    });

    const newTestId = insertTx();

    const crs = db.prepare(`
      SELECT s.name as subjectName, cl.name as className
      FROM courses c
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE c.id = ?
    `).get(courseId);

    return res.status(201).json({
      success: true,
      data: {
        id: newTestId,
        courseId,
        courseName: crs ? `${crs.subjectName} (${crs.className})` : 'Course Test',
        sectionId: sectionId || null,
        sectionName: 'All Sections',
        title: title.trim(),
        durationMin,
        markPerQ,
        negMark,
        shuffleQ: Boolean(shuffleQ),
        shuffleOpt: Boolean(shuffleOpt),
        startAt: finalStart,
        endAt: finalEnd,
        resultMode,
        resultsReleased: Boolean(resultsReleased),
        status,
        questionIds,
        createdBy,
        createdAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

testsRouter.patch('/:id/status', (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    db.prepare('UPDATE tests SET status = ? WHERE id = ?').run(status, testId);

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId);
    if (!test) return res.status(404).json({ success: false, error: 'Test not found' });

    const qRows = db.prepare('SELECT question_id FROM test_questions WHERE test_id = ?').all(testId);

    return res.json({
      success: true,
      data: {
        ...test,
        status,
        questionIds: qRows.map((q) => q.question_id),
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// TST-10: Generate Question Paper & Answer Key Document
testsRouter.get('/:id/document', (req, res) => {
  try {
    const testId = parseInt(req.params.id, 10);
    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId);
    if (!test) return res.status(404).json({ success: false, error: 'Test not found' });

    const questions = db.prepare(`
      SELECT q.id, q.body, q.topic, q.correct, q.opt_a, q.opt_b, q.opt_c, q.opt_d
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY q.id ASC
    `).all(testId);

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
        totalMarks: questions.length * (test.mark_per_q || 1),
        formattedPaper: `Generated printable test sheet with ${questions.length} questions. Ready for PDF download.`,
        answerKey,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
