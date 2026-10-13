import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageCourse, getStudentEnrolment } from '../services/access.js';
import { describeAttempt, finalizeAttempt, resultsVisible, seededShuffle } from '../services/grading.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';

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

  const [test, enrol] = await Promise.all([
    loadTest(testId),
    getStudentEnrolment(studentId),
  ]);
  if (!test) return fail(res, 404, 'Test not found');
  if (test.status !== 2) return fail(res, 403, 'This test is not available.');

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

  if (attempt.submitted_at) {
    const [{ n: questionCount }] = await sql`SELECT COUNT(*)::int AS n FROM test_questions WHERE test_id = ${testId}`;
    const dto = publicResult(describeAttempt(attempt, test, questionCount), resultsVisible(test, now));
    return res.json({
      success: true,
      data: {
        attempt: { ...dto, seed: attempt.seed, startedAt: attempt.started_at, deadlineAt: attempt.deadline_at, answers: {} },
        questions: [], deadlineAt: attempt.deadline_at, durationMin: test.duration_min, alreadySubmitted: true
      },
    });
  }

  // Parallelize answers and questions query (EXM-8: correct answers are NEVER selected here).
  const [answers, raw] = await Promise.all([
    sql`SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${attempt.id}`,
    sql`
      SELECT q.id, q.course_id, s.name AS subject_name, q.topic, q.body, q.image,
             q.opt_a, q.opt_b, q.opt_c, q.opt_d
      FROM questions q JOIN test_questions tq ON q.id = tq.question_id
      JOIN courses c ON c.id = q.course_id JOIN subjects s ON s.id = c.subject_id
      WHERE tq.test_id = ${testId} ORDER BY tq.question_order NULLS LAST, q.id ASC
    `
  ]);

  const answersMap = Object.fromEntries(answers.map((a) => [a.question_id, a.chosen]));
  const questionCount = raw.length;
  const dto = publicResult(describeAttempt(attempt, test, questionCount), resultsVisible(test, now));

  let questions = raw.map((q) => {
    let options = [
      { key: 'A', text: q.opt_a }, { key: 'B', text: q.opt_b },
      { key: 'C', text: q.opt_c }, { key: 'D', text: q.opt_d },
    ];
    if (test.shuffle_opt) options = seededShuffle(options, attempt.seed + q.id);
    // `key` is the ORIGINAL option id the client must send back; `label` is the A-D letter to display by position.
    options = options.map((o, i) => ({ ...o, label: 'ABCD'[i] }));
    return {
      id: q.id, topic: q.topic, body: q.body, image: q.image, options,
      ...(test.grand_test_id ? { courseId: q.course_id, subjectName: q.subject_name } : {}),
    };
  });
  if (test.shuffle_q && test.grand_test_id) {
    const subjectGroups = [];
    for (const question of questions) {
      const last = subjectGroups[subjectGroups.length - 1];
      if (!last || last[0].courseId !== question.courseId) subjectGroups.push([question]);
      else last.push(question);
    }
    questions = subjectGroups.flatMap((subjectQuestions) =>
      seededShuffle(subjectQuestions, attempt.seed + subjectQuestions[0].courseId));
  } else if (test.shuffle_q) questions = seededShuffle(questions, attempt.seed);

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
  const [row] = await sql`
    SELECT a.id AS attempt_id, a.test_id, a.student_id, a.seed, a.score, a.percentage, a.grade,
           a.correct_cnt, a.wrong_cnt, a.unanswered_cnt, a.started_at, a.deadline_at, a.submitted_at,
           t.id AS "t_id", t.course_id, t.title, t.duration_min, t.mark_per_q, t.shuffle_q, t.shuffle_opt,
           t.result_mode, t.results_released, t.status, t.start_at, t.end_at, t.grand_test_id,
           s.name AS "subjectName", cl.name AS "className"
    FROM attempts a
    JOIN tests t ON a.test_id = t.id
    JOIN courses c ON t.course_id = c.id
    JOIN subjects s ON c.subject_id = s.id
    JOIN classes cl ON c.class_id = cl.id
    WHERE a.id = ${attemptId}
  `;
  if (!row) return fail(res, 404, 'Attempt not found');

  const attempt = {
    id: row.attempt_id, test_id: row.test_id, student_id: row.student_id, seed: row.seed,
    score: row.score, percentage: row.percentage, grade: row.grade,
    correct_cnt: row.correct_cnt, wrong_cnt: row.wrong_cnt, unanswered_cnt: row.unanswered_cnt,
    started_at: row.started_at, deadline_at: row.deadline_at, submitted_at: row.submitted_at,
  };
  const test = {
    id: row.t_id, course_id: row.course_id, title: row.title, duration_min: row.duration_min,
    mark_per_q: row.mark_per_q, shuffle_q: row.shuffle_q, shuffle_opt: row.shuffle_opt,
    result_mode: row.result_mode, results_released: row.results_released, status: row.status,
    start_at: row.start_at, end_at: row.end_at, grand_test_id: row.grand_test_id,
    subjectName: row.subjectName, className: row.className,
  };

  const staff = STAFF_ROLES.includes(req.user.role);
  if (staff) {
    if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');
  } else {
    if (attempt.student_id !== req.user.id) return fail(res, 403, 'This is not your attempt.');
    if (!attempt.submitted_at) return fail(res, 403, 'Submit the test before reviewing it.');
    if (!resultsVisible(test)) return fail(res, 403, 'Results have not been released yet.');
  }

  const [questions, answers] = await Promise.all([
    sql`
      SELECT q.id, q.course_id, s.name AS subject_name, q.topic, q.body, q.image,
             q.opt_a, q.opt_b, q.opt_c, q.opt_d, q.correct, q.explanation
      FROM questions q JOIN test_questions tq ON q.id = tq.question_id
      JOIN courses c ON c.id = q.course_id JOIN subjects s ON s.id = c.subject_id
      WHERE tq.test_id = ${test.id} ORDER BY tq.question_order NULLS LAST, q.id ASC
    `,
    sql`SELECT question_id, chosen FROM attempt_answers WHERE attempt_id = ${attemptId}`
  ]);
  const chosenBy = new Map(answers.map((a) => [a.question_id, a.chosen]));

  const reviewQuestions = questions.map((q) => {
    const chosen = chosenBy.get(q.id) ?? null;
    return {
      id: q.id, topic: q.topic, body: q.body, image: q.image,
      subjectName: test.grand_test_id ? q.subject_name : null,
      options: [{ key: 'A', text: q.opt_a }, { key: 'B', text: q.opt_b }, { key: 'C', text: q.opt_c }, { key: 'D', text: q.opt_d }],
      chosenAnswer: chosen, correctAnswer: q.correct, isCorrect: chosen === q.correct, explanation: q.explanation,
    };
  });

  res.json({
    success: true,
    data: {
      attempt: describeAttempt(attempt, test, questions.length),
      test: {
        id: test.id, title: test.title,
        courseName: test.grand_test_id ? `Grand Test (${test.className})` : `${test.subjectName} (${test.className})`,
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
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM attempts a JOIN tests t ON a.test_id = t.id
    WHERE a.student_id = ${studentId}
      AND (${teacherId}::int IS NULL OR EXISTS (
            SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
  `;

  const rows = await sql`
    SELECT a.*, t.title, t.mark_per_q, t.result_mode, t.results_released, t.status, t.end_at,
           (SELECT COUNT(*)::int FROM test_questions WHERE test_id = t.id) AS question_count
    FROM attempts a JOIN tests t ON a.test_id = t.id
    WHERE a.student_id = ${studentId}
      AND (${teacherId}::int IS NULL OR EXISTS (
            SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
    ORDER BY a.id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;

  const data = rows.map((a) => {
    const dto = describeAttempt(a, a, a.question_count);
    const visible = req.user.role !== ROLE.STUDENT || resultsVisible(a);
    return { ...publicResult(dto, visible), testTitle: a.title, startedAt: a.started_at, deadlineAt: a.deadline_at };
  });
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

// RES-5: staff result list with rank.
examRouter.get('/test-attempts/:testId', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const testId = toInt(req.params.testId);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${testId}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const [{ n: questionCount }] = await sql`SELECT COUNT(*)::int AS n FROM test_questions WHERE test_id = ${testId}`;
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM attempts WHERE test_id = ${testId}`;
  const rows = await sql`
    SELECT a.*, u.username AS roll_no, u.full_name,
           RANK() OVER (ORDER BY a.score DESC NULLS LAST, a.submitted_at ASC) AS rank
    FROM attempts a JOIN users u ON a.student_id = u.id
    WHERE a.test_id = ${testId} ORDER BY a.score DESC NULLS LAST, a.submitted_at ASC
    LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;

  const data = rows.map((a, i) => ({
    ...describeAttempt(a, test, questionCount),
    rollNo: a.roll_no, fullName: a.full_name, startedAt: a.started_at,
    rank: a.submitted_at ? Number(a.rank) : null,
  }));
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));
