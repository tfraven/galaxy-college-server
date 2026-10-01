import express from 'express';
import { db } from '../db/connection.js';

export const examRouter = express.Router();

const gradeForPercentage = (pct) => {
  if (pct >= 80) return 'A+';
  if (pct >= 70) return 'A';
  if (pct >= 60) return 'B';
  if (pct >= 50) return 'C';
  if (pct >= 40) return 'D';
  return 'F';
};

// EXM-2 & EXM-3: Start or resume exam attempt
examRouter.post('/start', (req, res) => {
  try {
    const { testId, studentId } = req.body;
    if (!testId || !studentId) {
      return res.status(400).json({ success: false, error: 'testId and studentId are required' });
    }

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(testId);
    if (!test) {
      return res.status(404).json({ success: false, error: 'Test not found' });
    }

    let attempt = db.prepare('SELECT * FROM attempts WHERE test_id = ? AND student_id = ?').get(testId, studentId);

    if (!attempt) {
      const now = new Date();
      const deadline = new Date(
        Math.min(
          now.getTime() + test.duration_min * 60 * 1000,
          new Date(test.end_at).getTime()
        )
      );

      const seed = Math.floor(1000 + Math.random() * 9000);

      const insertRes = db.prepare(`
        INSERT INTO attempts (test_id, student_id, seed, started_at, deadline_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(testId, studentId, seed, now.toISOString(), deadline.toISOString());

      attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(insertRes.lastInsertRowid);
    }

    // Retrieve saved answers
    const answersRows = db.prepare('SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ?').all(attempt.id);
    const answersMap = {};
    for (const a of answersRows) {
      answersMap[a.question_id] = a.chosen;
    }

    // EXM-8: Correct answers are NEVER returned during an active exam!
    const questionsRaw = db.prepare(`
      SELECT q.id, q.topic, q.body, q.image, q.opt_a, q.opt_b, q.opt_c, q.opt_d
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY q.id ASC
    `).all(testId);

    const questions = questionsRaw.map((q) => ({
      id: q.id,
      topic: q.topic,
      body: q.body,
      image: q.image,
      options: [
        { key: 'A', text: q.opt_a },
        { key: 'B', text: q.opt_b },
        { key: 'C', text: q.opt_c },
        { key: 'D', text: q.opt_d },
      ],
    }));

    // EXM-4: Deterministic pseudo-random shuffle per student seed
    if (test.shuffle_q) {
      const seedMod = attempt.seed % 1000;
      questions.sort((a, b) => ((a.id * seedMod) % 17) - ((b.id * seedMod) % 17));
    }

    const attemptDto = {
      id: attempt.id,
      testId: attempt.test_id,
      studentId: attempt.student_id,
      seed: attempt.seed,
      startedAt: attempt.started_at,
      deadlineAt: attempt.deadline_at,
      submittedAt: attempt.submitted_at,
      score: attempt.score,
      percentage: attempt.score !== null ? Math.round((attempt.score / (questions.length * test.mark_per_q)) * 100) : null,
      grade: attempt.score !== null ? gradeForPercentage(Math.round((attempt.score / (questions.length * test.mark_per_q)) * 100)) : null,
      correctCnt: attempt.correct_cnt,
      wrongCnt: attempt.wrong_cnt,
      answers: answersMap,
    };

    return res.json({
      success: true,
      data: {
        attempt: attemptDto,
        questions,
        deadlineAt: attempt.deadline_at,
        durationMin: test.duration_min,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// EXM-6: Autosave answer
examRouter.post('/save-answer', (req, res) => {
  try {
    const { attemptId, questionId, chosen } = req.body;
    if (!attemptId || !questionId) {
      return res.status(400).json({ success: false, error: 'attemptId and questionId are required' });
    }

    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!attempt || attempt.submitted_at) {
      return res.status(400).json({ success: false, error: 'Attempt is already submitted or inactive' });
    }

    db.prepare(`
      INSERT INTO attempt_answers (attempt_id, question_id, chosen)
      VALUES (?, ?, ?)
      ON CONFLICT(attempt_id, question_id) DO UPDATE SET chosen = excluded.chosen
    `).run(attemptId, questionId, chosen || null);

    return res.json({ success: true });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// EXM-7 & RES-1: Submit and auto-grade attempt
examRouter.post('/submit', (req, res) => {
  try {
    const { attemptId } = req.body;
    if (!attemptId) {
      return res.status(400).json({ success: false, error: 'attemptId is required' });
    }

    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!attempt) {
      return res.status(404).json({ success: false, error: 'Attempt not found' });
    }

    const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(attempt.test_id);
    const questions = db.prepare(`
      SELECT q.id, q.correct
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ?
    `).all(test.id);

    const answers = db.prepare('SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ?').all(attemptId);
    const answersMap = {};
    for (const a of answers) {
      answersMap[a.question_id] = a.chosen;
    }

    let correctCnt = 0;
    let wrongCnt = 0;
    let unansweredCnt = 0;

    for (const q of questions) {
      const chosen = answersMap[q.id];
      if (!chosen) {
        unansweredCnt++;
      } else if (chosen === q.correct) {
        correctCnt++;
      } else {
        wrongCnt++;
      }
    }

    const rawScore = correctCnt * test.mark_per_q - wrongCnt * test.neg_mark;
    const finalScore = Math.max(0, Math.round(rawScore * 100) / 100);
    const maxMarks = questions.length * test.mark_per_q;
    const percentage = maxMarks > 0 ? Math.round((finalScore / maxMarks) * 100) : 0;
    const grade = gradeForPercentage(percentage);
    const submittedAt = new Date().toISOString();

    db.prepare(`
      UPDATE attempts
      SET submitted_at = ?, correct_cnt = ?, wrong_cnt = ?, score = ?
      WHERE id = ?
    `).run(submittedAt, correctCnt, wrongCnt, finalScore, attemptId);

    return res.json({
      success: true,
      data: {
        id: attemptId,
        testId: test.id,
        studentId: attempt.student_id,
        score: finalScore,
        percentage,
        grade,
        correctCnt,
        wrongCnt,
        unansweredCnt,
        submittedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// RES-4: Get attempt review
examRouter.get('/review/:attemptId', (req, res) => {
  try {
    const attemptId = parseInt(req.params.attemptId, 10);
    const attempt = db.prepare('SELECT * FROM attempts WHERE id = ?').get(attemptId);
    if (!attempt) return res.status(404).json({ success: false, error: 'Attempt not found' });

    const test = db.prepare(`
      SELECT t.*, s.name as subjectName, cl.name as className
      FROM tests t
      JOIN courses c ON t.course_id = c.id
      JOIN subjects s ON c.subject_id = s.id
      JOIN classes cl ON c.class_id = cl.id
      WHERE t.id = ?
    `).get(attempt.test_id);

    const questionsRaw = db.prepare(`
      SELECT q.id, q.topic, q.body, q.image, q.opt_a, q.opt_b, q.opt_c, q.opt_d, q.correct, q.explanation
      FROM questions q
      JOIN test_questions tq ON q.id = tq.question_id
      WHERE tq.test_id = ?
      ORDER BY q.id ASC
    `).all(test.id);

    const answers = db.prepare('SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ?').all(attemptId);
    const answersMap = {};
    for (const a of answers) {
      answersMap[a.question_id] = a.chosen;
    }

    const reviewQuestions = questionsRaw.map((q) => {
      const chosen = answersMap[q.id];
      return {
        id: q.id,
        topic: q.topic,
        body: q.body,
        image: q.image,
        options: [
          { key: 'A', text: q.opt_a },
          { key: 'B', text: q.opt_b },
          { key: 'C', text: q.opt_c },
          { key: 'D', text: q.opt_d },
        ],
        chosenAnswer: chosen,
        correctAnswer: q.correct,
        isCorrect: chosen === q.correct,
        explanation: q.explanation,
      };
    });

    const maxMarks = questionsRaw.length * test.mark_per_q;
    const percentage = attempt.score !== null && maxMarks > 0 ? Math.round((attempt.score / maxMarks) * 100) : 0;
    const grade = gradeForPercentage(percentage);

    return res.json({
      success: true,
      data: {
        attempt: {
          id: attempt.id,
          testId: attempt.test_id,
          studentId: attempt.student_id,
          score: attempt.score,
          percentage,
          grade,
          correctCnt: attempt.correct_cnt,
          wrongCnt: attempt.wrong_cnt,
          unansweredCnt: questionsRaw.length - (attempt.correct_cnt || 0) - (attempt.wrong_cnt || 0),
          submittedAt: attempt.submitted_at,
        },
        test: {
          id: test.id,
          title: test.title,
          courseName: `${test.subjectName} (${test.className})`,
          durationMin: test.duration_min,
          markPerQ: test.mark_per_q,
          questionIds: questionsRaw.map((q) => q.id),
        },
        reviewQuestions,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Student's completed attempts
examRouter.get('/student-attempts/:studentId', (req, res) => {
  try {
    const studentId = parseInt(req.params.studentId, 10);
    const attempts = db.prepare(`
      SELECT 
        a.id,
        a.test_id as testId,
        a.student_id as studentId,
        a.started_at as startedAt,
        a.deadline_at as deadlineAt,
        a.submitted_at as submittedAt,
        a.correct_cnt as correctCnt,
        a.wrong_cnt as wrongCnt,
        a.score,
        t.title as testTitle,
        t.mark_per_q as markPerQ,
        (SELECT COUNT(*) FROM test_questions WHERE test_id = t.id) as questionCount
      FROM attempts a
      JOIN tests t ON a.test_id = t.id
      WHERE a.student_id = ?
      ORDER BY a.id DESC
    `).all(studentId);

    const data = attempts.map((a) => {
      const maxMarks = a.questionCount * a.markPerQ;
      const percentage = a.score !== null && maxMarks > 0 ? Math.round((a.score / maxMarks) * 100) : 0;
      return {
        id: a.id,
        testId: a.testId,
        studentId: a.studentId,
        startedAt: a.startedAt,
        deadlineAt: a.deadlineAt,
        submittedAt: a.submittedAt,
        correctCnt: a.correctCnt,
        wrongCnt: a.wrongCnt,
        unansweredCnt: a.questionCount - (a.correctCnt || 0) - (a.wrongCnt || 0),
        score: a.score,
        percentage,
        grade: gradeForPercentage(percentage),
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// All attempts for a test
examRouter.get('/test-attempts/:testId', (req, res) => {
  try {
    const testId = parseInt(req.params.testId, 10);
    const attempts = db.prepare(`
      SELECT 
        a.id,
        a.test_id as testId,
        a.student_id as studentId,
        u.username as rollNo,
        u.full_name as fullName,
        a.started_at as startedAt,
        a.submitted_at as submittedAt,
        a.correct_cnt as correctCnt,
        a.wrong_cnt as wrongCnt,
        a.score,
        t.mark_per_q as markPerQ,
        (SELECT COUNT(*) FROM test_questions WHERE test_id = t.id) as questionCount
      FROM attempts a
      JOIN users u ON a.student_id = u.id
      JOIN tests t ON a.test_id = t.id
      WHERE a.test_id = ?
      ORDER BY a.score DESC
    `).all(testId);

    const data = attempts.map((a) => {
      const maxMarks = a.questionCount * a.markPerQ;
      const percentage = a.score !== null && maxMarks > 0 ? Math.round((a.score / maxMarks) * 100) : 0;
      return {
        id: a.id,
        testId: a.testId,
        studentId: a.studentId,
        rollNo: a.rollNo,
        fullName: a.fullName,
        startedAt: a.startedAt,
        submittedAt: a.submittedAt,
        correctCnt: a.correctCnt,
        wrongCnt: a.wrongCnt,
        score: a.score,
        percentage,
        grade: gradeForPercentage(percentage),
      };
    });

    return res.json({ success: true, data });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
