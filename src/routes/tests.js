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
  courseName: t.grand_test_order === 0
    ? `${t.classname} · ${t.grand_subject_count || 0} subjects`
    : `${t.subjectname} (${t.classname})`,
  subjectNames: t.grand_test_order === 0 ? (t.grand_subject_names || []) : [],
  subjectCount: t.grand_test_order === 0 ? Number(t.grand_subject_count || 0) : null,
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
  grandTestOrder: t.grand_test_order ?? null,
  questionIds: (t.question_ids || []).map(Number),
  createdBy: t.created_by,
  createdAt: t.created_at,
});

const publishedExamNotification = (row) => {
  if (row.grand_test_order === 0) {
    const startAt = row.start_at ?? row.startAt;
    const startDate = startAt ? new Date(startAt) : null;
    const availableFrom = startDate && !Number.isNaN(startDate.getTime())
      ? ` from ${startDate.toLocaleString()}`
      : '';
    return {
      type: 'exam_published',
      title: `Grand Test published: ${row.title}`,
      body: `${row.classname} · ${row.grand_subject_count} subjects are available${availableFrom}.`,
    };
  }
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
const fetchTests = ({ testId = null, grandTestId = null, teacherId = null, classId = null, sectionId = null, courseId = null, searchPattern = null, pagination = null, summaryOnly = false } = {}) => sql`
  SELECT t.id, t.course_id, t.section_id, t.title, t.duration_min, t.mark_per_q, t.neg_mark, t.test_type, t.grand_test_id, t.grand_test_order,
         t.shuffle_q, t.shuffle_opt, t.start_at, t.end_at, t.result_mode, t.results_released, t.status,
         t.created_by, t.created_at,
         s.name AS subjectname, cl.name AS classname, c.class_id, sec.name AS sectionname,
         (SELECT COUNT(*)::int FROM tests child WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0) AS grand_subject_count,
         COALESCE((SELECT array_agg(subject.name ORDER BY child.grand_test_order)
                   FROM tests child JOIN courses child_course ON child_course.id = child.course_id
                   JOIN subjects subject ON subject.id = child_course.subject_id
                   WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0), '{}') AS grand_subject_names,
         COALESCE((SELECT array_agg(tq.question_id ORDER BY tq.question_order NULLS LAST, tq.question_id) FROM test_questions tq WHERE tq.test_id = t.id), '{}') AS question_ids
  FROM tests t
  JOIN courses c ON t.course_id = c.id
  JOIN subjects s ON c.subject_id = s.id
  JOIN classes cl ON c.class_id = cl.id
  LEFT JOIN sections sec ON t.section_id = sec.id
  WHERE (${testId}::int IS NULL OR t.id = ${testId}::int)
    AND (${grandTestId}::int IS NULL OR t.grand_test_id = ${grandTestId}::int)
    AND (${teacherId}::int IS NULL OR EXISTS (
          SELECT 1 FROM teacher_courses tc
          WHERE tc.user_id = ${teacherId}::int
            AND (tc.course_id = t.course_id OR (t.grand_test_order = 0 AND EXISTS (
              SELECT 1 FROM tests child JOIN teacher_courses child_tc ON child_tc.course_id = child.course_id
              WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
                AND child_tc.user_id = ${teacherId}::int
            )))))
    AND (${classId}::int IS NULL OR (
          t.status = 2 AND c.class_id = ${classId}::int
          AND (t.section_id IS NULL OR t.section_id = ${sectionId}::int)))
    AND (${courseId}::int IS NULL OR t.course_id = ${courseId}::int OR (t.grand_test_order = 0 AND EXISTS (
      SELECT 1 FROM tests child WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
        AND child.course_id = ${courseId}::int
    )))
    AND (${searchPattern}::text IS NULL OR CONCAT_WS(' ', t.title, s.name, cl.name, sec.name) ILIKE ${searchPattern}::text OR
      (t.grand_test_order = 0 AND EXISTS (
        SELECT 1 FROM tests child JOIN courses child_course ON child_course.id = child.course_id
        JOIN subjects child_subject ON child_subject.id = child_course.subject_id
        WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
          AND CONCAT_WS(' ', child_subject.name, cl.name) ILIKE ${searchPattern}::text
      )))
    AND (${summaryOnly}::boolean = FALSE OR t.grand_test_id IS NULL OR t.grand_test_order = 0)
  ORDER BY CASE WHEN ${grandTestId}::int IS NOT NULL THEN t.grand_test_order END ASC NULLS LAST,
           CASE WHEN t.grand_test_id IS NULL THEN t.id
                ELSE (SELECT MAX(child.id) FROM tests child WHERE child.grand_test_id = t.grand_test_id) END DESC,
           t.grand_test_order ASC NULLS LAST, t.id DESC
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
          AND (t.grand_test_id IS NULL OR t.grand_test_order = 0)
      `;
      total = count;
      rows = await fetchTests({ classId: enrol.class_id, sectionId: enrol.section_id, pagination, summaryOnly: true });
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
        SELECT 1 FROM teacher_courses tc
        WHERE tc.user_id = ${teacherId}::int
          AND (tc.course_id = t.course_id OR (t.grand_test_order = 0 AND EXISTS (
            SELECT 1 FROM tests child JOIN teacher_courses child_tc ON child_tc.course_id = child.course_id
            WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
              AND child_tc.user_id = ${teacherId}::int
          )))))
        AND (${courseId}::int IS NULL OR t.course_id = ${courseId}::int OR (t.grand_test_order = 0 AND EXISTS (
          SELECT 1 FROM tests child WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
            AND child.course_id = ${courseId}::int
        )))
        AND (${searchPattern}::text IS NULL OR CONCAT_WS(' ', t.title, s.name, cl.name, sec.name) ILIKE ${searchPattern}::text OR
          (t.grand_test_order = 0 AND EXISTS (
            SELECT 1 FROM tests child JOIN courses child_course ON child_course.id = child.course_id
            JOIN subjects child_subject ON child_subject.id = child_course.subject_id
            WHERE child.grand_test_id = t.grand_test_id AND child.grand_test_order > 0
              AND CONCAT_WS(' ', child_subject.name, cl.name) ILIKE ${searchPattern}::text
          )))
        AND (t.grand_test_id IS NULL OR t.grand_test_order = 0)
    `;
    total = count;
    rows = await fetchTests({ teacherId, courseId, searchPattern, pagination, summaryOnly: true });
  }
  res.json({ success: true, data: rows.map(toDto), pagination: paginationMeta(total, pagination) });
}));

// A Grand Test is one student-facing assessment with internally grouped subject papers.
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
  const requestedSubjects = Array.isArray(req.body?.subjects) ? req.body.subjects : null;
  const start = new Date(req.body?.startAt || Date.now());
  const end = new Date(req.body?.endAt || Date.now() + 7 * 864e5);
  if (!classId || !title || title.length > 180) return fail(res, 400, 'Choose a class and enter a Grand Test title.');
  if (!Number.isInteger(durationMin) || durationMin < 1 || !Number.isFinite(markPerQ) || markPerQ <= 0 || !Number.isFinite(negMark) || negMark < 0) {
    return fail(res, 400, 'Enter a valid duration and grading scheme.');
  }
  if (![1, 2, 3].includes(resultMode) || ![1, 2].includes(status) || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return fail(res, 400, 'Choose a valid schedule, result mode, and status.');
  }
  if (!requestedSubjects?.length) return fail(res, 400, 'Choose at least one question for every subject.');
  const [activeClass] = await sql`SELECT id FROM classes WHERE id = ${classId} AND is_active = TRUE`;
  if (!activeClass) return fail(res, 400, 'Choose an active class for the Grand Test.');
  const selectedSubjects = requestedSubjects.map((subject) => ({
    courseId: Number(subject?.courseId),
    questionIds: Array.isArray(subject?.questionIds) ? subject.questionIds.map(Number) : [],
  }));
  if (selectedSubjects.some(({ courseId, questionIds }) =>
    !Number.isSafeInteger(courseId) || courseId <= 0 || !questionIds.length ||
    questionIds.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(questionIds).size !== questionIds.length) ||
    new Set(selectedSubjects.map(({ courseId }) => courseId)).size !== selectedSubjects.length) {
    return fail(res, 400, 'Choose unique active questions for every subject.');
  }
  const subjects = await sql`
    SELECT c.id AS course_id, s.name AS subject_name, COUNT(q.id)::int AS question_count
    FROM courses c JOIN subjects s ON s.id = c.subject_id
    LEFT JOIN questions q ON q.course_id = c.id AND q.is_active = TRUE
    WHERE c.class_id = ${classId} AND s.is_active = TRUE
    GROUP BY c.id, s.name ORDER BY s.name
  `;
  if (!subjects.length) return fail(res, 400, 'This class has no subjects. Add its courses before creating a Grand Test.');
  const classCourseIds = new Set(subjects.map((subject) => subject.course_id));
  if (selectedSubjects.length !== subjects.length || selectedSubjects.some(({ courseId }) => !classCourseIds.has(courseId))) {
    return fail(res, 400, 'A Grand Test must include every subject in the selected class exactly once.');
  }
  const emptySubjects = subjects.filter((subject) => subject.question_count < 1).map((subject) => subject.subject_name);
  if (emptySubjects.length) return fail(res, 400, `Add active questions to every subject first. Missing: ${emptySubjects.join(', ')}.`);
  for (const subject of selectedSubjects) {
    const [{ n }] = await sql`
      SELECT COUNT(*)::int AS n FROM questions
      WHERE id = ANY(${subject.questionIds}::int[]) AND course_id = ${subject.courseId} AND is_active = TRUE
    `;
    if (n !== subject.questionIds.length) return fail(res, 400, 'Some selected questions are inactive or belong to another subject.');
  }

  const subjectPayload = JSON.stringify(selectedSubjects.map((subject, index) => ({
    course_id: subject.courseId, sort_order: index + 1, question_ids: subject.questionIds,
  })));
  const subjectOrder = JSON.stringify(selectedSubjects.map(({ courseId }) => courseId));
  const [{ id: grandTestId }] = await sql`
    WITH requested AS (
      SELECT * FROM jsonb_to_recordset(${subjectPayload}::jsonb)
        AS item(course_id INTEGER, sort_order INTEGER, question_ids JSONB)
    ), g AS (
      INSERT INTO grand_test_groups (class_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                                     start_at, end_at, result_mode, status, created_by, subject_order)
      VALUES (${classId}, ${title}, ${durationMin}, ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
              ${start.toISOString()}, ${end.toISOString()}, ${resultMode}, ${status}, ${req.user.id}, ${subjectOrder}::jsonb)
      RETURNING id
    ), master_test AS (
      INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                         start_at, end_at, result_mode, results_released, status, created_by, test_type, grand_test_id, grand_test_order)
      SELECT c.id, NULL, ${title}, ${durationMin}, ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
             ${start.toISOString()}, ${end.toISOString()}, ${resultMode}, ${resultMode !== 3}, ${status}, ${req.user.id},
             'grand_test', g.id, 0
      FROM g JOIN requested ON requested.sort_order = 1
      JOIN courses c ON c.id = requested.course_id AND c.class_id = ${classId}
      RETURNING id
    ), master_questions AS (
      INSERT INTO test_questions (test_id, question_id, question_order)
      SELECT master_test.id, selected.question_id::int,
             ROW_NUMBER() OVER (ORDER BY requested.sort_order, selected.question_order)::int
      FROM master_test CROSS JOIN requested
      CROSS JOIN LATERAL jsonb_array_elements_text(requested.question_ids) WITH ORDINALITY
        AS selected(question_id, question_order)
      RETURNING test_id
    ), subject_tests AS (
      INSERT INTO tests (course_id, section_id, title, duration_min, mark_per_q, neg_mark, shuffle_q, shuffle_opt,
                         start_at, end_at, result_mode, results_released, status, created_by, test_type, grand_test_id, grand_test_order)
      SELECT c.id, NULL, ${title} || ' — ' || s.name, ${durationMin}, ${markPerQ}, ${negMark}, ${shuffleQ}, ${shuffleOpt},
             ${start.toISOString()}, ${end.toISOString()}, ${resultMode}, ${resultMode !== 3}, ${status}, ${req.user.id},
             'grand_test', g.id, requested.sort_order
      FROM g CROSS JOIN requested JOIN courses c ON c.id = requested.course_id JOIN subjects s ON s.id = c.subject_id
      WHERE c.class_id = ${classId}
      ORDER BY requested.sort_order
      RETURNING id, course_id
    ), linked_questions AS (
      INSERT INTO test_questions (test_id, question_id, question_order)
      SELECT st.id, selected.question_id::int, selected.question_order::int
      FROM subject_tests st
      JOIN requested ON requested.course_id = st.course_id
      CROSS JOIN LATERAL jsonb_array_elements_text(requested.question_ids) WITH ORDINALITY
        AS selected(question_id, question_order)
      RETURNING test_id
    )
    SELECT id FROM g
  `;
  const created = await fetchTests({ grandTestId });
  const master = created.find((row) => row.grand_test_order === 0);
  if (!master) throw new Error('Grand Test master record was not created.');
  if (status === 2) {
    await notifyStudents({ ...publishedExamNotification(master), relatedType: 'test', relatedId: master.id,
      eventKey: `grand_test_published:${grandTestId}`, classId: master.class_id });
  }
  res.status(201).json({ success: true, data: {
    id: grandTestId, title, classId, subjectCount: subjects.length, test: toDto(master),
    subjects: created.filter((row) => row.grand_test_order > 0).map(toDto),
  } });
}));

testsRouter.get('/grand/:id', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [group] = await sql`SELECT g.*, c.name AS class_name FROM grand_test_groups g JOIN classes c ON c.id = g.class_id WHERE g.id = ${id}`;
  if (!group) return fail(res, 404, 'Grand Test not found.');
  const rows = await fetchTests({ grandTestId: group.id });
  const master = rows.find((row) => row.grand_test_order === 0);
  res.json({ success: true, data: { id: group.id, title: group.title, classId: group.class_id,
    className: group.class_name, startAt: group.start_at, endAt: group.end_at,
    status: group.status, subjectOrder: group.subject_order || [], test: master ? toDto(master) : null,
    subjects: rows.filter((row) => row.grand_test_order > 0).map(toDto) } });
}));

testsRouter.get('/grand/:id/results', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [group] = await sql`
    SELECT g.id, g.title, g.class_id, g.mark_per_q, g.neg_mark, g.status,
           c.name AS class_name
    FROM grand_test_groups g JOIN classes c ON c.id = g.class_id WHERE g.id = ${id}
  `;
  if (!group) return fail(res, 404, 'Grand Test not found.');

  const groupTests = await sql`
    SELECT t.id, t.course_id, t.grand_test_order, s.name AS subject_name
    FROM tests t JOIN courses c ON c.id = t.course_id JOIN subjects s ON s.id = c.subject_id
    WHERE t.grand_test_id = ${id} ORDER BY t.grand_test_order
  `;
  const master = groupTests.find((test) => test.grand_test_order === 0);
  if (!master) return fail(res, 409, 'This Grand Test is not ready for combined results.');
  const subjects = groupTests.filter((test) => test.grand_test_order > 0).map((test) => ({
    id: test.course_id, name: test.subject_name, questionCount: 0, maxMarks: 0,
  }));
  const subjectByCourseId = new Map(subjects.map((subject) => [subject.id, subject]));
  const questions = await sql`
    SELECT q.id, q.course_id, q.body, q.topic, q.correct
    FROM test_questions tq JOIN questions q ON q.id = tq.question_id
    WHERE tq.test_id = ${master.id} ORDER BY tq.question_order NULLS LAST, q.id
  `;
  for (const question of questions) {
    const subject = subjectByCourseId.get(question.course_id);
    if (subject) subject.questionCount += 1;
  }
  for (const subject of subjects) subject.maxMarks = subject.questionCount * Number(group.mark_per_q);

  const students = await sql`
    SELECT u.id, u.username AS roll_no, u.full_name
    FROM students st JOIN users u ON u.id = st.user_id
    WHERE st.class_id = ${group.class_id} AND u.is_active = TRUE
    ORDER BY u.full_name, u.username
  `;
  const testById = new Map(groupTests.map((test) => [test.id, test]));
  const testIds = groupTests.map((test) => test.id);
  const attempts = await sql`
    SELECT id, test_id, student_id, submitted_at
    FROM attempts WHERE test_id = ANY(${testIds}::int[])
  `;
  const attemptsByStudent = new Map();
  for (const attempt of attempts) {
    const test = testById.get(attempt.test_id);
    if (!test) continue;
    if (!attemptsByStudent.has(attempt.student_id)) {
      attemptsByStudent.set(attempt.student_id, { master: null, subjects: new Map() });
    }
    const studentAttempts = attemptsByStudent.get(attempt.student_id);
    if (test.grand_test_order === 0) studentAttempts.master = attempt;
    else studentAttempts.subjects.set(test.course_id, attempt);
  }
  const attemptIds = attempts.map((attempt) => attempt.id);
  const answers = attemptIds.length ? await sql`
    SELECT attempt_id, question_id, chosen FROM attempt_answers WHERE attempt_id = ANY(${attemptIds}::int[])
  ` : [];
  const answerByAttempt = new Map();
  for (const answer of answers) {
    if (!answerByAttempt.has(answer.attempt_id)) answerByAttempt.set(answer.attempt_id, new Map());
    answerByAttempt.get(answer.attempt_id).set(answer.question_id, answer.chosen);
  }
  const questionBySubject = new Map(subjects.map((subject) => [subject.id, []]));
  for (const question of questions) questionBySubject.get(question.course_id)?.push(question);

  const analyticsAnswersByStudent = new Map();
  const reportRows = students.map((student) => {
    const studentAttempts = attemptsByStudent.get(student.id) || { master: null, subjects: new Map() };
    const masterAttempt = studentAttempts.master;
    const subjectAttempts = studentAttempts.subjects;
    const submittedMaster = Boolean(masterAttempt?.submitted_at);
    const submittedAllLegacySubjects = subjects.length > 0 && subjects.every((subject) => subjectAttempts.get(subject.id)?.submitted_at);
    const submittedAt = masterAttempt
      ? masterAttempt.submitted_at || null
      : (submittedAllLegacySubjects
        ? [...subjectAttempts.values()].reduce((latest, attempt) => !latest || new Date(attempt.submitted_at) > new Date(latest)
          ? attempt.submitted_at : latest, null)
        : null);
    const studentAnswers = new Map();
    const attemptsToRead = masterAttempt ? [masterAttempt] : [...subjectAttempts.values()];
    for (const attempt of attemptsToRead) {
      for (const [questionId, chosen] of answerByAttempt.get(attempt.id) || []) studentAnswers.set(questionId, chosen);
    }
    const submittedAttemptsToRead = masterAttempt
      ? (submittedMaster ? [masterAttempt] : [])
      : [...subjectAttempts.values()].filter((attempt) => attempt.submitted_at);
    const submittedAnswers = new Map();
    for (const attempt of submittedAttemptsToRead) {
      for (const [questionId, chosen] of answerByAttempt.get(attempt.id) || []) submittedAnswers.set(questionId, chosen);
    }
    analyticsAnswersByStudent.set(student.id, submittedAnswers);

    const subjectResults = {};
    let totalCorrect = 0;
    let totalWrong = 0;
    let totalUnanswered = 0;
    for (const subject of subjects) {
      const subjectQuestions = questionBySubject.get(subject.id) || [];
      let correct = 0;
      let wrong = 0;
      let unanswered = 0;
      for (const question of subjectQuestions) {
        const answer = studentAnswers.get(question.id);
        if (!answer) unanswered += 1;
        else if (answer === question.correct) correct += 1;
        else wrong += 1;
      }
      totalCorrect += correct;
      totalWrong += wrong;
      totalUnanswered += unanswered;
      const rawScore = correct * Number(group.mark_per_q) - wrong * Number(group.neg_mark);
      const subjectAttempt = subjectAttempts.get(subject.id);
      const subjectSubmitted = masterAttempt
        ? submittedMaster
        : Boolean(subjectAttempt?.submitted_at);
      const score = subjectSubmitted ? Math.max(0, Math.round(rawScore * 100) / 100) : null;
      subjectResults[subject.id] = {
        correct, wrong, unanswered, score, maxMarks: subject.maxMarks,
        percentage: score === null || !subject.maxMarks ? null : Math.round((score / subject.maxMarks) * 100),
        rank: null,
        attempted: Boolean(masterAttempt || subjectAttempt),
        submittedAt: subjectSubmitted ? masterAttempt?.submitted_at || subjectAttempt?.submitted_at || null : null,
      };
    }
    const overallMaxMarks = questions.length * Number(group.mark_per_q);
    const rawOverallScore = totalCorrect * Number(group.mark_per_q) - totalWrong * Number(group.neg_mark);
    const overallScore = submittedAt ? Math.max(0, Math.round(rawOverallScore * 100) / 100) : null;
    return {
      studentId: student.id, rollNo: student.roll_no, fullName: student.full_name,
      attempted: Boolean(masterAttempt || subjectAttempts.size), submittedAt,
      subjects: subjectResults,
      overall: {
        correct: totalCorrect, wrong: totalWrong, unanswered: totalUnanswered,
        score: overallScore, maxMarks: overallMaxMarks,
        percentage: overallScore === null || !overallMaxMarks ? null : Math.round((overallScore / overallMaxMarks) * 100),
        rank: null,
      },
    };
  });
  const assignRanks = (scoreOf, assign) => {
    const ranked = reportRows.filter((row) => scoreOf(row) !== null).sort((a, b) =>
      scoreOf(b) - scoreOf(a) || a.rollNo.localeCompare(b.rollNo));
    let rank = 0;
    let previousScore = null;
    ranked.forEach((row, index) => {
      const score = scoreOf(row);
      if (score !== previousScore) rank = index + 1;
      assign(row, rank);
      previousScore = score;
    });
  };
  assignRanks((row) => row.overall.score, (row, rank) => { row.overall.rank = rank; });
  for (const subject of subjects) {
    assignRanks((row) => row.subjects[subject.id].score, (row, rank) => {
      row.subjects[subject.id].rank = rank;
    });
  }

  const questionAnalytics = questions.map((question, index) => {
    const subject = subjectByCourseId.get(question.course_id);
    const breakdown = { A: 0, B: 0, C: 0, D: 0 };
    let submittedCount = 0;
    let totalResponses = 0;
    let correctCount = 0;
    for (const student of reportRows) {
      if (student.subjects[question.course_id]?.score === null) continue;
      submittedCount += 1;
      const chosen = analyticsAnswersByStudent.get(student.studentId)?.get(question.id);
      if (!chosen) continue;
      if (Object.hasOwn(breakdown, chosen)) breakdown[chosen] += 1;
      totalResponses += 1;
      if (chosen === question.correct) correctCount += 1;
    }
    return {
      questionId: question.id,
      questionNumber: index + 1,
      subjectId: question.course_id,
      subjectName: subject?.name || 'Subject',
      body: question.body,
      topic: question.topic,
      correct: question.correct,
      submittedCount,
      totalResponses,
      unanswered: submittedCount - totalResponses,
      breakdown,
      accuracy: totalResponses ? Math.round((correctCount / totalResponses) * 100) : 0,
    };
  });

  res.json({ success: true, data: {
    id: group.id, title: group.title, classId: group.class_id, className: group.class_name,
    status: group.status, totalQuestions: questions.length,
    totalMarks: questions.length * Number(group.mark_per_q),
    submittedCount: reportRows.filter((row) => row.submittedAt).length,
    subjects, students: reportRows, questionAnalytics,
  } });
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
    WHERE tq.test_id = ${id} ORDER BY tq.question_order NULLS LAST, q.id ASC
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
  const [activeCourse] = await sql`
    SELECT c.id FROM courses c
    JOIN classes cl ON cl.id = c.class_id
    JOIN subjects s ON s.id = c.subject_id
    WHERE c.id = ${courseId} AND cl.is_active = TRUE AND s.is_active = TRUE
  `;
  if (!activeCourse) return fail(res, 400, 'Choose an active course from the curriculum.');
  if (!(await canManageCourse(req.user, courseId))) return fail(res, 403, 'You are not assigned to this course.');

  const now = new Date();
  const start = startAt ? new Date(startAt) : now;
  const end = endAt ? new Date(endAt) : new Date(now.getTime() + 7 * 864e5);
  if (isNaN(start) || isNaN(end) || end <= start) return fail(res, 400, 'End time must be after start time');

  if (sectionId) {
    const [sec] = await sql`
      SELECT 1 FROM sections s JOIN courses c ON c.class_id = s.class_id WHERE s.id = ${sectionId} AND s.is_active = TRUE AND c.id = ${courseId}
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
      INSERT INTO test_questions (test_id, question_id, question_order)
      SELECT t.id, q.question_id, q.question_order::int
      FROM t, unnest(${questionIds}::int[]) WITH ORDINALITY AS q(question_id, question_order)
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
  if (row.grand_test_id && ![ROLE.ADMIN, ROLE.OPERATOR].includes(req.user.role)) return fail(res, 403, 'Only Admin or Operator can change a Grand Test schedule.');
  if (status !== row.status && !TRANSITIONS[row.status]?.includes(status)) {
    return fail(res, 400, 'Allowed flow is Draft -> Published -> Closed.');
  }

  const affectedTests = row.grand_test_id
    ? await fetchTests({ grandTestId: row.grand_test_id })
    : [row];
  if (row.grand_test_id) {
    await sql`UPDATE tests SET status = ${status} WHERE grand_test_id = ${row.grand_test_id}`;
    await sql`UPDATE grand_test_groups SET status = ${status} WHERE id = ${row.grand_test_id}`;
  } else {
    await sql`UPDATE tests SET status = ${status} WHERE id = ${id}`;
  }
  const [updated] = await fetchTests({ testId: id });
  if (status === 2 && row.status !== 2) {
    if (row.grand_test_id) {
      const master = affectedTests.find((affected) => affected.grand_test_order === 0);
      if (master) {
        const [published] = await fetchTests({ testId: master.id });
        await notifyStudents({ ...publishedExamNotification(published), relatedType: 'test', relatedId: master.id,
          eventKey: `grand_test_published:${row.grand_test_id}`, classId: master.class_id });
      }
    } else {
      await notifyStudents({ ...publishedExamNotification(updated), relatedType: 'test', relatedId: updated.id,
        eventKey: `exam_published:${updated.id}`, classId: updated.class_id, sectionId: updated.section_id });
    }
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
  if (row.grand_test_id && ![ROLE.ADMIN, ROLE.OPERATOR].includes(req.user.role)) return fail(res, 403, 'Only Admin or Operator can release Grand Test results.');
  if (row.grand_test_id) await sql`UPDATE tests SET results_released = ${released} WHERE grand_test_id = ${row.grand_test_id}`;
  else await sql`UPDATE tests SET results_released = ${released} WHERE id = ${id}`;
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
    WHERE tq.test_id = ${id} ORDER BY tq.question_order NULLS LAST, q.id ASC
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
  if (test.grand_test_id) return fail(res, 400, 'Subject papers cannot be edited individually in a Grand Test.');
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
        INSERT INTO test_questions (test_id, question_id, question_order)
        SELECT ${id}, q.question_id, q.question_order::int
        FROM unnest(${qIds}::int[]) WITH ORDINALITY AS q(question_id, question_order)
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
  if (test.grand_test_id) return fail(res, 400, 'Subject papers cannot be deleted individually from a Grand Test.');
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
    ORDER BY tq.question_order NULLS LAST, q.id ASC
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
