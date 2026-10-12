import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageCourse, getStudentEnrolment } from '../services/access.js';
import { notifyStudents } from '../services/notifications.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';

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
  testType: t.test_type || 'quiz',
  grandTestId: t.grand_test_id || null,
  questionIds: (t.question_ids || []).map(Number),
  createdBy: t.created_by,
  createdAt: t.created_at,
});

const publishedExamNotification = (row) => {
  const courseName = row.subjectname
    ? `${row.subjectname}${row.classname ? ` (${row.classname})` : ''}`
    : `Exam "${row.title}"`;
  const startAt = row.start_at ?? row.startAt;
  const startDate = startAt ? new Date(startAt) : null;
  const availableFrom = startDate && !Number.isNaN(startDate.getTime())
    ? ` from ${startDate.toLocaleString()}`
    : '';

  return {
    type: 'exam_published',
    title: `Exam published: ${row.title}`,
    body: `${courseName} is available${availableFrom}.`,
  };
};

// One query (question ids via array_agg) instead of 1 + N queries. Filters are optional NULL-able params.
const fetchTests = ({ testId = null, grandTestId = null, teacherId = null, classId = null, sectionId = null, courseId = null, searchPattern = null, pagination = null } = {}) => sql`
  SELECT t.id, t.course_id, t.section_id, t.title, t.duration_min, t.mark_per_q, t.neg_mark, t.test_type, t.grand_test_id,
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
    AND (${grandTestId}::int IS NULL OR t.grand_test_id = ${grandTestId}::int)
    AND (${teacherId}::int IS NULL OR EXISTS (
          SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
    AND (${classId}::int IS NULL OR (
          t.status = 2 AND c.class_id = ${classId}::int
          AND (t.section_id IS NULL OR t.section_id = ${sectionId}::int)))
    AND (${courseId}::int IS NULL OR t.course_id = ${courseId}::int)
    AND (${searchPattern}::text IS NULL OR CONCAT_WS(' ', t.title, s.name, cl.name, sec.name) ILIKE ${searchPattern}::text)
  ORDER BY t.id DESC
  LIMIT ${pagination?.pageSize ?? 1000} OFFSET ${pagination?.offset ?? 0}
`;

// EXM-1 / TST-6: students see only Published tests of their own class/section; staff see their scope.
testsRouter.get('/', asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  let rows;
  let total = 0;
  if (req.user.role === ROLE.STUDENT) {
    const enrol = await getStudentEnrolment(req.user.id);
    if (enrol) {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM tests t JOIN courses c ON c.id = t.course_id
        WHERE t.status = 2 AND c.class_id = ${enrol.class_id}
          AND (t.section_id IS NULL OR t.section_id = ${enrol.section_id})
      `;
      total = count;
      rows = await fetchTests({ classId: enrol.class_id, sectionId: enrol.section_id, pagination });
    } else rows = [];
  } else {
    const teacherId = req.user.role === ROLE.TEACHER ? req.user.id : null;
    const courseId = toInt(req.query.courseId);
    const search = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const searchPattern = search ? `%${search}%` : null;
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM tests t
      JOIN courses c ON c.id = t.course_id
      JOIN subjects s ON s.id = c.subject_id
      JOIN classes cl ON cl.id = c.class_id
      LEFT JOIN sections sec ON sec.id = t.section_id
      WHERE (${teacherId}::int IS NULL OR EXISTS (
        SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = t.course_id))
        AND (${courseId}::int IS NULL OR t.course_id = ${courseId}::int)
        AND (${searchPattern}::text IS NULL OR CONCAT_WS(' ', t.title, s.name, cl.name, sec.name) ILIKE ${searchPattern}::text)
    `;
    total = count;
    rows = await fetchTests({ teacherId, courseId, searchPattern, pagination });
  }
  res.json({ success: true, data: rows.map(toDto), pagination: paginationMeta(total, pagination) });
}));

// A Grand Test is one scheduled assessment made up of one independently graded test per class subject.
testsRouter.post('/grand', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const classId = toInt(req.body?.classId);
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
  const durationMin = Number(req.body?.durationMin ?? 30);
  const markPerQ = Number(req.body?.markPerQ ?? 1);
  const negMark = Number(req.body?.negMark ?? 0);
  const resultMode = toInt(req.body?.resultMode ?? 1);
  const status = toInt(req.body?.status ?? 1);
  const shuffleQ = req.body?.shuffleQ !== false;
  const shuffleOpt = req.body?.shuffleOpt !== false;
  const start = new Date(req.body?.startAt || Date.now());
  const end = new Date(req.body?.endAt || Date.now() + 7 * 864e5);
  if (!classId || !title || title.length > 180) return fail(res, 400, 'Choose a class and enter a Grand Test title.');
  if (!Number.isInteger(durationMin) || durationMin < 1 || !Number.isFinite(markPerQ) || markPerQ <= 0 || !Number.isFinite(negMark) || negMark < 0) {
    return fail(res, 400, 'Enter a valid duration and grading scheme.');
  }
  if (![1, 2, 3].includes(resultMode) || ![1, 2].includes(status) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return fail(res, 400, 'Choose a valid schedule, result mode, and status.');
  }
  const subjects = await sql`
    SELECT c.id AS course_id, s.name AS subject_name, COUNT(q.id)::int AS question_count
    FROM courses c JOIN subjects s ON s.id = c.subject_id
    LEFT JOIN questions q ON q.course_id = c.id AND q.is_active = TRUE
    WHERE c.class_id = ${classId}
    GROUP BY c.id, s.name ORDER BY s.name
  `;
  if (!subjects.length) return fail(res, 400, 'This class has no subjects. Add its courses before creating a Grand Test.');
  const emptySubjects = subjects.filter((subject) => subject.question_count < 1).map((subject) => subject.subject_name);
  if (emptySubjects.length) return fail(res, 400, `Add active questions to every subject first. Missing: ${emptySubjects.join(', ')}.`);

  const [{ id: grandTestId }] = await sql`
    WITH g AS (
      INSERT INTO grand_test_groups (class_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                                     start_at, end_at, result_mode, status, created_by)
      VALUES (${classId}, ${title}, ${durationMin}, ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
              ${start.toISOString()}, ${end.toISOString()}, ${resultMode}, ${status}, ${req.user.id})
      RETURNING id
    ), subject_tests AS (
      INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                         start_at, end_at, result_mode, results_released, status, created_by, test_type, grand_test_id)
      SELECT c.id, NULL, ${title} || ' — ' || s.name, ${durationMin}, ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
             ${start.toISOString()}, ${end.toISOString()}, ${resultMode}, ${resultMode !== 3}, ${status}, ${req.user.id},
             'grand_test', g.id
      FROM g CROSS JOIN courses c JOIN subjects s ON s.id = c.subject_id
      WHERE c.class_id = ${classId}
      RETURNING id, course_id
    ), linked_questions AS (
      INSERT INTO test_questions (test_id, question_id)
      SELECT st.id, q.id FROM subject_tests st JOIN questions q ON q.course_id = st.course_id AND q.is_active = TRUE
      RETURNING test_id
    )
    SELECT id FROM g
  `;
  const created = await fetchTests({ grandTestId });
  if (status === 2) {
    for (const row of created) {
      const [course] = await sql`SELECT class_id FROM courses WHERE id = ${row.course_id}`;
      await notifyStudents({ ...publishedExamNotification(row), relatedType: 'test', relatedId: row.id,
        eventKey: `exam_published:${row.id}`, classId: course.class_id });
    }
  }
  res.status(201).json({ success: true, data: { id: grandTestId, title, classId, subjectCount: subjects.length, tests: created.map(toDto) } });
}));

testsRouter.get('/grand/:id', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [group] = await sql`SELECT g.*, c.name AS class_name FROM grand_test_groups g JOIN classes c ON c.id = g.class_id WHERE g.id = ${id}`;
  if (!group) return fail(res, 404, 'Grand Test not found.');
  const rows = await fetchTests({ grandTestId: group.id });
  res.json({ success: true, data: { id: group.id, title: group.title, classId: group.class_id,
    className: group.class_name, startAt: group.start_at, endAt: group.end_at,
    status: group.status, subjects: rows.map(toDto) } });
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
    courseId, sectionId, title, testType = 'quiz', durationMin = 15, markPerQ = 1, negMark = 0,
    shuffleQ = true, shuffleOpt = true, startAt, endAt, resultMode = 1, status = 1,
  } = req.body || {};
  const questionIds = Array.isArray(req.body?.questionIds) ? [...new Set(req.body.questionIds.map(toInt))].filter((n) => n !== null) : [];

  if (!courseId || !title?.trim() || !questionIds.length) {
    return fail(res, 400, 'Course, title, and at least 1 question are required');
  }
  if (!['quiz', 'class_test'].includes(testType)) return fail(res, 400, 'Choose Quiz or Class Test. Grand Tests must use the Grand Test scheduler.');
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
                         start_at, end_at, result_mode, results_released, status, created_by, test_type)
      VALUES (${courseId}, ${sectionId || null}, ${title.trim()}, ${durationMin}, ${markPerQ}, ${negMark},
              ${shuffleQ}, ${shuffleOpt}, ${start.toISOString()}, ${end.toISOString()}, ${resultMode},
              ${resultMode !== 3}, ${status}, ${req.user.id}, ${testType})
      RETURNING id
    ), tq AS (
      INSERT INTO test_questions (test_id, question_id)
      SELECT t.id, q FROM t, unnest(${questionIds}::int[]) AS q
    )
    SELECT id FROM t
  `;

  const [row] = await fetchTests({ testId: id });
  if (status === 2) {
    const [course] = await sql`SELECT class_id FROM courses WHERE id = ${courseId}`;
    await notifyStudents({
      ...publishedExamNotification(row),
      relatedType: 'test', relatedId: id, eventKey: `exam_published:${id}`,
      classId: course.class_id, sectionId: sectionId || null,
    });
  }
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
  if (status === 2 && row.status !== 2) {
    const [course] = await sql`SELECT class_id FROM courses WHERE id = ${row.course_id}`;
    await notifyStudents({
      ...publishedExamNotification(updated),
      relatedType: 'test', relatedId: id, eventKey: `exam_published:${id}`,
      classId: course.class_id, sectionId: row.section_id,
    });
  }
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

// Update Test (staff / admin)
testsRouter.put('/:id', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${id}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const {
    title, durationMin, markPerQ, negMark, shuffleQ, shuffleOpt,
    startAt, endAt, resultMode, sectionId, questionIds
  } = req.body || {};

  const updatedTitle = title !== undefined ? title.trim() : test.title;
  const updatedDuration = durationMin !== undefined ? parseInt(durationMin, 10) : test.duration_min;
  const updatedMark = markPerQ !== undefined ? parseFloat(markPerQ) : parseFloat(test.mark_per_q);
  const updatedNeg = negMark !== undefined ? parseFloat(negMark) : parseFloat(test.neg_mark);
  const updatedShuffleQ = shuffleQ !== undefined ? Boolean(shuffleQ) : test.shuffle_q;
  const updatedShuffleOpt = shuffleOpt !== undefined ? Boolean(shuffleOpt) : test.shuffle_opt;
  const updatedStart = startAt ? new Date(startAt).toISOString() : test.start_at;
  const updatedEnd = endAt ? new Date(endAt).toISOString() : test.end_at;
  const updatedResultMode = resultMode !== undefined ? parseInt(resultMode, 10) : test.result_mode;
  const updatedSectionId = sectionId !== undefined ? (sectionId ? toInt(sectionId) : null) : test.section_id;

  await sql`
    UPDATE tests
    SET title = ${updatedTitle},
        duration_min = ${updatedDuration},
        mark_per_q = ${updatedMark},
        neg_mark = ${updatedNeg},
        shuffle_q = ${updatedShuffleQ},
        shuffle_opt = ${updatedShuffleOpt},
        start_at = ${updatedStart},
        end_at = ${updatedEnd},
        result_mode = ${updatedResultMode},
        section_id = ${updatedSectionId}
    WHERE id = ${id}
  `;

  if (Array.isArray(questionIds) && questionIds.length > 0) {
    const qIds = [...new Set(questionIds.map(toInt))].filter((n) => n !== null);
    await sql.transaction([
      sql`DELETE FROM test_questions WHERE test_id = ${id}`,
      sql`
        INSERT INTO test_questions (test_id, question_id)
        SELECT ${id}, q FROM unnest(${qIds}::int[]) AS q
      `
    ]);
  }

  const [row] = await fetchTests({ testId: id });
  res.json({ success: true, data: toDto(row) });
}));

// Delete Test (if no attempts or in draft)
testsRouter.delete('/:id', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${id}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const attempts = await sql`SELECT COUNT(*)::int AS count FROM attempts WHERE test_id = ${id}`;
  if (attempts[0]?.count > 0 && test.status !== 1) {
    return fail(res, 400, 'Cannot delete an exam with active student attempts. You can close it instead.');
  }

  await sql.transaction([
    sql`DELETE FROM test_questions WHERE test_id = ${id}`,
    sql`DELETE FROM attempts WHERE test_id = ${id}`,
    sql`DELETE FROM tests WHERE id = ${id}`,
  ]);

  res.json({ success: true, data: { id, deleted: true } });
}));

// Analytics for test (per-question breakdown, pass rates, score distribution)
testsRouter.get('/:id/analytics', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [test] = await sql`SELECT * FROM tests WHERE id = ${id}`;
  if (!test) return fail(res, 404, 'Test not found');
  if (!(await canManageCourse(req.user, test.course_id))) return fail(res, 403, 'Not your course.');

  const attempts = await sql`
    SELECT a.*, u.full_name AS student_name, u.username AS roll_no
    FROM attempts a
    JOIN users u ON a.student_id = u.id
    WHERE a.test_id = ${id}
  `;

  const totalAttempts = attempts.length;
  const submitted = attempts.filter((a) => a.submitted_at);
  const scores = submitted.map((a) => parseFloat(a.score) || 0);

  const avgScore = scores.length ? (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1) : 0;
  const maxScore = scores.length ? Math.max(...scores) : 0;
  const minScore = scores.length ? Math.min(...scores) : 0;

  // Question level breakdown
  const questions = await sql`
    SELECT q.id, q.body, q.topic, q.correct, q.opt_a, q.opt_b, q.opt_c, q.opt_d
    FROM questions q
    JOIN test_questions tq ON q.id = tq.question_id
    WHERE tq.test_id = ${id}
    ORDER BY q.id ASC
  `;

  const answers = await sql`
    SELECT aa.question_id, aa.chosen
    FROM attempt_answers aa
    JOIN attempts a ON aa.attempt_id = a.id
    WHERE a.test_id = ${id} AND a.submitted_at IS NOT NULL
  `;

  const qStats = questions.map((q) => {
    const qAnswers = answers.filter((a) => a.question_id === q.id);
    const totalAns = qAnswers.length;
    const aCount = qAnswers.filter((a) => a.chosen === 'A').length;
    const bCount = qAnswers.filter((a) => a.chosen === 'B').length;
    const cCount = qAnswers.filter((a) => a.chosen === 'C').length;
    const dCount = qAnswers.filter((a) => a.chosen === 'D').length;
    const correctCount = qAnswers.filter((a) => a.chosen === q.correct).length;
    const accuracy = totalAns > 0 ? Math.round((correctCount / totalAns) * 100) : 0;

    return {
      questionId: q.id,
      body: q.body,
      topic: q.topic,
      correct: q.correct,
      totalResponses: totalAns,
      breakdown: { A: aCount, B: bCount, C: cCount, D: dCount },
      accuracy,
    };
  });

  res.json({
    success: true,
    data: {
      totalAttempts,
      submittedCount: submitted.length,
      averageScore: Number(avgScore),
      maxScore: Number(maxScore),
      minScore: Number(minScore),
      questionAnalytics: qStats,
    },
  });
}));
