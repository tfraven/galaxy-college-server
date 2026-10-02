import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageCourse, getStudentEnrolment } from '../services/access.js';
import { describeAttempt, finalizeAttempt, resultsVisible, seededShuffle } from '../services/grading.js';

export const examRouter = express.Router();

const GRACE_MS = 5000; // tolerate small network delays on the last autosave

// Hide marks when the test's result mode says results are not out yet (RES-3).
const publicResult = (dto, visible) =>
  visible ? dto : { ...dto, score: null, percentage: null, grade: null, correctCnt: null, wrongCnt: null, unansweredCnt: null, resultsHidden: true };

const loadTest = async (testId) => {
  const [t] = await sql`
    SELECT t.*, c.class_id AS course_class_id FROM tests t JOIN courses c ON c.id = t.course_id WHERE t.id = ${testId}`;
  return t || null;
};

// EXM-2 / EXM-3 / EXM-4: start or resume. The student id comes from the token, never from the body.
examRouter.post('/start', requireRole(ROLE.STUDENT), asyncHandler(async (req, res) => {
  const testId = toInt(req.body?.testId);
  if (testId === null) return fail(res, 400, 'testId is required');
  const studentId = req.user.id;

  const test = await loadTest(testId);
  if (!test) return fail(res, 404, 'Test not found');
  if (test.status !== 2) return fail(res, 403, 'This test is not available.');

  const enrol = await getStudentEnrolment(studentId);
  if (!enrol || enrol.class_id !== test.course_class_id || (test.section_id && test.section_id !== enrol.section_id)) {
    return fail(res, 403, 'This test is not for your class/section.');
  }

  const now = new Date();
  let [attempt] = await sql`SELECT * FROM attempts WHERE test_id = ${testId} AND student_id = ${studentId}`;

  if (!attempt) {
    if (now < new Date(test.start_at)) return fail(res, 403, 'This test has not started yet.');
    if (now >= new Date(test.end_at)) return fail(res, 403, 'This test has ended.');

    const deadline = new Date(Math.min(now.getTime() + test.duration_min * 60000, new Date(test.end_at).getTime()));
    const seed = Math.floor(1000 + Math.random() * 900000);
    // ON CONFLICT covers a double-tap on Start: both requests end up with the same attempt (EXM-2).
    [attempt] = await sql`
      INSERT INTO attempts (test_id, student_id, seed, started_at, deadline_at)
      VALUES (${testId}, ${studentId}, ${seed}, ${now.toISOString()}, ${deadline.toISOString()})
      ON CONFLICT (test_id, student_id) DO UPDATE SET test_id = EXCLUDED.test_id
      RETURNING *
    `;
  }

  // Server clock rules (EXM-3): an expired attempt is finalized here, not resumed.
  if (!attempt.submitted_at && now >= new Date(attempt.deadline_at)) {
    const done = await finalizeAttempt(attempt.id);
    attempt = done.attempt;
  }

  const [{ n: questionCount }] = await sql`SELECT COUNT(*)::int AS n FROM test_questions WHERE test_id = ${testId}`;
  const dto = publicResult(describeAttempt(attempt, test, questionCount), resultsVisible(test, now));

  if (attempt.submitted_at) {
    return res.json({
      success: true,
      data: {
        attempt: { ...dto, seed: attempt.seed, startedAt: attempt.started_at, deadlineAt: attempt.deadline_at, answers: {} },
        questions: [], deadlineAt: attempt.deadline_at, durationMin: test.duration_min, alreadySubmitted: true
      },
    });
  }

  const answers = await sql`SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${attempt.id}`;
  const answersMap = Object.fromEntries(answers.map((a) => [a.question_id, a.chosen]));

  // EXM-8: correct answers are NEVER selected here.
  const raw = await sql`
    SELECT q.id, q.topic, q.body, q.image, q.opt_a, q.opt_b, q.opt_c, q.opt_d
    FROM questions q JOIN test_questions tq ON q.id = tq.question_id
    WHERE tq.test_id = ${testId} ORDER BY q.id ASC
  `;

  let questions = raw.map((q) => {
    let options = [
      { key: 'A', text: q.opt_a }, { key: 'B', text: q.opt_b },
      { key: 'C', text: q.opt_c }, { key: 'D', text: q.opt_d },
    ];
    if (test.shuffle_opt) options = seededShuffle(options, attempt.seed + q.id);
    // `key` is the ORIGINAL option id the client must send back; `label` is the A-D letter to display by position.
    options = options.map((o, i) => ({ ...o, label: 'ABCD'[i] }));
    return { id: q.id, topic: q.topic, body: q.body, image: q.image, options };
  });
  if (test.shuffle_q) questions = seededShuffle(questions, attempt.seed);

  res.json({
    success: true,
    data: {
      attempt: { ...dto, seed: attempt.seed, startedAt: attempt.started_at, deadlineAt: attempt.deadline_at, answers: answersMap },
      questions,
      deadlineAt: attempt.deadline_at,
      durationMin: test.duration_min,
    },
  });
}));

// EXM-6: autosave. Rejects other students' attempts, foreign questions, and writes after the deadline.
examRouter.post('/save-answer', requireRole(ROLE.STUDENT), asyncHandler(async (req, res) => {
  const attemptId = toInt(req.body?.attemptId);
  const questionId = toInt(req.body?.questionId);
  const chosen = req.body?.chosen ? String(req.body.chosen).toUpperCase() : null;
  if (attemptId === null || questionId === null) return fail(res, 400, 'attemptId and questionId are required');
  if (chosen !== null && !['A', 'B', 'C', 'D'].includes(chosen)) return fail(res, 400, 'chosen must be A, B, C, D or empty');

  const [attempt] = await sql`SELECT * FROM attempts WHERE id = ${attemptId} AND student_id = ${req.user.id}`;
  if (!attempt) return fail(res, 404, 'Attempt not found');
  if (attempt.submitted_at || Date.now() > new Date(attempt.deadline_at).getTime() + GRACE_MS) {
    return fail(res, 400, 'Attempt is already submitted or time is up');
  }

  const inTest = await sql`SELECT 1 FROM test_questions WHERE test_id = ${attempt.test_id} AND question_id = ${questionId}`;
  if (!inTest.length) return fail(res, 400, 'Question is not part of this test');

  await sql`
    INSERT INTO attempt_answers (attempt_id, question_id, chosen) VALUES (${attemptId}, ${questionId}, ${chosen})
    ON CONFLICT (attempt_id, question_id) DO UPDATE SET chosen = EXCLUDED.chosen
  `;
  res.json({ success: true });
}));

// EXM-7 / EXM-10 / RES-1: idempotent submit (a retry returns the stored result).
examRouter.post('/submit', requireRole(ROLE.STUDENT), asyncHandler(async (req, res) => {
  const attemptId = toInt(req.body?.attemptId);
  if (attemptId === null) return fail(res, 400, 'attemptId is required');

  const [own] = await sql`SELECT id FROM attempts WHERE id = ${attemptId} AND student_id = ${req.user.id}`;
  if (!own) return fail(res, 404, 'Attempt not found');

  const r = await finalizeAttempt(attemptId);
  const dto = publicResult(describeAttempt(r.attempt, r.test, r.questionCount), resultsVisible(r.test));
  res.json({ success: true, data: dto });
}));

// RES-4: review. Owner (or staff of that course) only, only after submission, only when results are released.
examRouter.get('/review/:attemptId', asyncHandler(async (req, res) => {
  const attemptId = toInt(req.params.attemptId);
  const [attempt] = await sql`SELECT * FROM attempts WHERE id = ${attemptId}`;
  if (!attempt) return fail(res, 404, 'Attempt not found');

  const [test] = await sql`
    SELECT t.*, s.name AS "subjectName", cl.name AS "className"
    FROM tests t JOIN courses c ON t.course_id = c.id JOIN subjects s ON c.subject_id = s.id JOIN classes cl ON c.class_id = cl.id
    WHERE t.id = ${attempt.test_id}
  `;

  const staff = STAFF_ROLES.includes(req.user.role);
  if (staff) {
    if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');
  } else {
    if (attempt.student_id !== req.user.id) return fail(res, 403, 'This is not your attempt.');
    if (!attempt.submitted_at) return fail(res, 403, 'Submit the test before reviewing it.');
    if (!resultsVisible(test)) return fail(res, 403, 'Results have not been released yet.');
  }

  const questions = await sql`
    SELECT q.id, q.topic, q.body, q.image, q.opt_a, q.opt_b, q.opt_c, q.opt_d, q.correct, q.explanation
    FROM questions q JOIN test_questions tq ON q.id = tq.question_id
    WHERE tq.test_id = ${test.id} ORDER BY q.id ASC
  `;
  const answers = await sql`SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${attemptId}`;
  const chosenBy = new Map(answers.map((a) => [a.question_id, a.chosen]));

  const reviewQuestions = questions.map((q) => {
    const chosen = chosenBy.get(q.id) ?? null;
    return {
      id: q.id, topic: q.topic, body: q.body, image: q.image,
      options: [{ key: 'A', text: q.opt_a }, { key: 'B', text: q.opt_b }, { key: 'C', text: q.opt_c }, { key: 'D', text: q.opt_d }],
      chosenAnswer: chosen, correctAnswer: q.correct, isCorrect: chosen === q.correct, explanation: q.explanation,
    };
  });

  res.json({
    success: true,
    data: {
      attempt: describeAttempt(attempt, test, questions.length),
      test: {
        id: test.id, title: test.title, courseName: `${test.subjectName} (${test.className})`,
        durationMin: test.duration_min, markPerQ: parseFloat(test.mark_per_q), questionIds: questions.map((q) => q.id),
      },
      reviewQuestions,
    },
  });
}));

// A student's own attempts (RES-4). Staff may look up any student within their scope of use.
examRouter.get('/student-attempts/:studentId', asyncHandler(async (req, res) => {
  const studentId = toInt(req.params.studentId);
  if (req.user.role === ROLE.STUDENT && studentId !== req.user.id) return fail(res, 403, 'You can only view your own results.');
  const teacherId = req.user.role === ROLE.TEACHER ? req.user.id : null;

  const rows = await sql`
    SELECT a.*, t.title, t.mark_per_q, t.result_mode, t.results_released, t.status, t.end_at,
           (SELECT COUNT(*)::int FROM test_questions WHERE test_id = t.id) AS question_count
    FROM attempts a JOIN tests t ON a.test_id = t.id
    WHERE a.student_id = ${studentId}
      AND (${teacherId}::int IS NULL OR EXISTS (
            SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
    ORDER BY a.id DESC
  `;

  const data = rows.map((a) => {
    const dto = describeAttempt(a, a, a.question_count);
    const visible = req.user.role !== ROLE.STUDENT || resultsVisible(a);
    return { ...publicResult(dto, visible), testTitle: a.title, startedAt: a.started_at, deadlineAt: a.deadline_at };
  });
  res.json({ success: true, data });
}));

// RES-5: staff result list with rank.
examRouter.get('/test-attempts/:testId', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const testId = toInt(req.params.testId);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${testId}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const [{ n: questionCount }] = await sql`SELECT COUNT(*)::int AS n FROM test_questions WHERE test_id = ${testId}`;
  const rows = await sql`
    SELECT a.*, u.username AS roll_no, u.full_name
    FROM attempts a JOIN users u ON a.student_id = u.id
    WHERE a.test_id = ${testId} ORDER BY a.score DESC NULLS LAST, a.submitted_at ASC
  `;

  const data = rows.map((a, i) => ({
    ...describeAttempt(a, test, questionCount),
    rollNo: a.roll_no, fullName: a.full_name, startedAt: a.started_at,
    rank: a.submitted_at ? i + 1 : null,
  }));
  res.json({ success: true, data });
}));