import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageCourse, getStudentEnrolment } from '../services/access.js';

export const testsRouter = express.Router();

const toDto = (t) => ({
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
  questionIds: (t.question_ids || []).map(Number),
  createdBy: t.created_by,
  createdAt: t.created_at,
});

// One query (question ids via array_agg) instead of 1 + N queries. Filters are optional NULL-able params.
const fetchTests = ({ testId = null, teacherId = null, classId = null, sectionId = null } = {}) => sql`
  SELECT t.id, t.course_id, t.section_id, t.title, t.duration_min, t.mark_per_q, t.neg_mark,
         t.shuffle_q, t.shuffle_opt, t.start_at, t.end_at, t.result_mode, t.results_released, t.status,
         t.created_by, t.created_at,
         s.name AS subjectname, cl.name AS classname, sec.name AS sectionname,
         COALESCE((SELECT array_agg(tq.question_id ORDER BY tq.question_id) FROM test_questions tq WHERE tq.test_id = t.id), '{}') AS question_ids
  FROM tests t
  JOIN courses c ON t.course_id = c.id
  JOIN subjects s ON c.subject_id = s.id
  JOIN classes cl ON c.class_id = cl.id
  LEFT JOIN sections sec ON t.section_id = sec.id
  WHERE (${testId}::int IS NULL OR t.id = ${testId}::int)
    AND (${teacherId}::int IS NULL OR EXISTS (
          SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
    AND (${classId}::int IS NULL OR (
          t.status = 2 AND c.class_id = ${classId}::int
          AND (t.section_id IS NULL OR t.section_id = ${sectionId}::int)))
  ORDER BY t.id DESC
`;

// EXM-1 / TST-6: students see only Published tests of their own class/section; staff see their scope.
testsRouter.get('/', asyncHandler(async (req, res) => {
  let rows;
  if (req.user.role === ROLE.STUDENT) {
    const enrol = await getStudentEnrolment(req.user.id);
    if (!enrol) return res.json({ success: true, data: [] });
    rows = await fetchTests({ classId: enrol.class_id, sectionId: enrol.section_id });
  } else {
    rows = await fetchTests({ teacherId: req.user.role === ROLE.TEACHER ? req.user.id : null });
  }
  res.json({ success: true, data: rows.map(toDto) });
}));

// Includes correct answers, so staff only.
testsRouter.get('/:id', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [row] = await fetchTests({ testId: id });
  if (!row) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, row.course_id))) return fail(res, 403, 'Not your course.');

  const questions = await sql`
    SELECT q.id, q.course_id AS "courseId", q.topic, q.body, q.image,
           q.opt_a AS "optA", q.opt_b AS "optB", q.opt_c AS "optC", q.opt_d AS "optD",
           q.correct, q.explanation, q.is_active AS "isActive"
    FROM questions q JOIN test_questions tq ON q.id = tq.question_id
    WHERE tq.test_id = ${id} ORDER BY q.id ASC
  `;
  res.json({ success: true, data: { test: toDto(row), questions } });
}));

testsRouter.post('/', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const {
    courseId, sectionId, title, durationMin = 15, markPerQ = 1, negMark = 0,
    shuffleQ = true, shuffleOpt = true, startAt, endAt, resultMode = 1, status = 1,
  } = req.body || {};
  const questionIds = Array.isArray(req.body?.questionIds) ? [...new Set(req.body.questionIds.map(toInt))].filter((n) => n !== null) : [];

  if (!courseId || !title?.trim() || !questionIds.length) {
    return fail(res, 400, 'Course, title, and at least 1 question are required');
  }
  if (!(durationMin > 0) || !(markPerQ > 0) || negMark < 0) return fail(res, 400, 'Invalid duration or marks');
  if (![1, 2, 3].includes(resultMode) || ![1, 2, 3].includes(status)) return fail(res, 400, 'Invalid result mode or status');
  if (!(await canManageCourse(req.user, courseId))) return fail(res, 403, 'You are not assigned to this course.');

  const now = new Date();
  const start = startAt ? new Date(startAt) : now;
  const end = endAt ? new Date(endAt) : new Date(now.getTime() + 7 * 864e5);
  if (isNaN(start) || isNaN(end) || end <= start) return fail(res, 400, 'End time must be after start time');

  if (sectionId) {
    const [sec] = await sql`
      SELECT 1 FROM sections s JOIN courses c ON c.class_id = s.class_id WHERE s.id = ${sectionId} AND c.id = ${courseId}
    `;
    if (!sec) return fail(res, 400, 'Section does not belong to this course\'s class');
  }

  // Every question must be active and belong to this course.
  const [{ n }] = await sql`
    SELECT COUNT(*)::int AS n FROM questions WHERE id = ANY(${questionIds}::int[]) AND course_id = ${courseId} AND is_active`;
  if (n !== questionIds.length) return fail(res, 400, 'Some questions are inactive or belong to another course');

  // Test + its questions in one atomic statement (before: N separate inserts, half-created tests on failure).
  const [{ id }] = await sql`
    WITH t AS (
      INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                         start_at, end_at, result_mode, results_released, status, created_by)
      VALUES (${courseId}, ${sectionId || null}, ${title.trim()}, ${durationMin}, ${markPerQ}, ${negMark},
              ${shuffleQ}, ${shuffleOpt}, ${start.toISOString()}, ${end.toISOString()}, ${resultMode},
              ${resultMode !== 3}, ${status}, ${req.user.id})
      RETURNING id
    ), tq AS (
      INSERT INTO test_questions (test_id, question_id)
      SELECT t.id, q FROM t, unnest(${questionIds}::int[]) AS q
    )
    SELECT id FROM t
  `;

  const [row] = await fetchTests({ testId: id });
  res.status(201).json({ success: true, data: toDto(row) });
}));

const TRANSITIONS = { 1: [2], 2: [3] }; // Draft -> Published -> Closed (TST-6)

testsRouter.patch('/:id/status', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const status = toInt(req.body?.status);
  if (![1, 2, 3].includes(status)) return fail(res, 400, 'Status must be 1 (Draft), 2 (Published) or 3 (Closed)');

  const [row] = await fetchTests({ testId: id });
  if (!row) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, row.course_id))) return fail(res, 403, 'Not your course.');
  if (status !== row.status && !TRANSITIONS[row.status]?.includes(status)) {
    return fail(res, 400, 'Allowed flow is Draft -> Published -> Closed.');
  }

  await sql`UPDATE tests SET status = ${status} WHERE id = ${id}`;
  const [updated] = await fetchTests({ testId: id });
  res.json({ success: true, data: toDto(updated) });
}));

// RES-3 (manual release mode)
testsRouter.patch('/:id/release', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const released = req.body?.released !== false;
  const [row] = await fetchTests({ testId: id });
  if (!row) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, row.course_id))) return fail(res, 403, 'Not your course.');
  await sql`UPDATE tests SET results_released = ${released} WHERE id = ${id}`;
  res.json({ success: true, data: { id, resultsReleased: released } });
}));

// TST-10: data for the printable Question Paper + Answer Key (PDF is rendered client-side/on demand).
testsRouter.get('/:id/document', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${id}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const questions = await sql`
    SELECT q.id, q.body, q.topic, q.image, q.correct, q.opt_a, q.opt_b, q.opt_c, q.opt_d
    FROM questions q JOIN test_questions tq ON q.id = tq.question_id
    WHERE tq.test_id = ${id} ORDER BY q.id ASC
  `;

  res.json({
    success: true,
    data: {
      paperTitle: `${test.title} (Question Paper)`,
      totalQuestions: questions.length,
      totalMarks: questions.length * (parseFloat(test.mark_per_q) || 1),
      formattedPaper: `Printable test sheet with ${questions.length} questions.`,
      paper: questions.map((q, i) => ({
        qNum: i + 1, body: q.body, image: q.image,
        options: { A: q.opt_a, B: q.opt_b, C: q.opt_c, D: q.opt_d },
      })),
      answerKey: questions.map((q, i) => ({ qNum: i + 1, correct: q.correct, topic: q.topic })),
    },
  });
}));