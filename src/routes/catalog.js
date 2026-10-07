import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageCourse } from '../services/access.js';

// CAT-3: the catalog contains correct answers, so students must never reach it.
export const catalogRouter = express.Router();
catalogRouter.use(requireRole(...STAFF_ROLES));


catalogRouter.get('/questions', asyncHandler(async (req, res) => {
  const courseId = toInt(req.query.courseId);
  const teacherId = req.user.role === ROLE.TEACHER ? req.user.id : null;

  const data = await sql`
    SELECT q.id, q.course_id AS "courseId", q.topic, q.body, q.image,
           q.opt_a AS "optA", q.opt_b AS "optB", q.opt_c AS "optC", q.opt_d AS "optD",
           q.correct, q.explanation, q.is_active AS "isActive",
           q.created_by AS "createdBy", q.created_at AS "createdAt"
    FROM questions q
    WHERE q.is_active = TRUE
      AND (${courseId}::int IS NULL OR q.course_id = ${courseId}::int)
      AND (${teacherId}::int IS NULL OR EXISTS (
            SELECT 1 FROM teacher_courses tc WHERE tc.user_id = ${teacherId}::int AND tc.course_id = q.course_id))
    ORDER BY q.id DESC
  `;
  res.json({ success: true, data });
}));

catalogRouter.post('/questions', asyncHandler(async (req, res) => {
  const { courseId, topic, body, image, optA, optB, optC, optD, correct, explanation } = req.body || {};
  if (!courseId || !body?.trim() || !optA?.trim() || !optB?.trim() || !optC?.trim() || !optD?.trim() || !correct) {
    return fail(res, 400, 'All 4 options, question body, and correct answer are required');
  }
  const upper = String(correct).toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(upper)) return fail(res, 400, 'Correct option must be A, B, C, or D');
  if (!(await canManageCourse(req.user, courseId))) return fail(res, 403, 'You are not assigned to this course.');

  const [q] = await sql`
    INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
    VALUES (${courseId}, ${topic || null}, ${body.trim()}, ${image || null},
            ${optA.trim()}, ${optB.trim()}, ${optC.trim()}, ${optD.trim()},
            ${upper}, ${explanation || null}, ${req.user.id})
    RETURNING id, course_id AS "courseId", topic, body, image,
              opt_a AS "optA", opt_b AS "optB", opt_c AS "optC", opt_d AS "optD",
              correct, explanation, is_active AS "isActive", created_by AS "createdBy", created_at AS "createdAt"
  `;
  res.status(201).json({ success: true, data: q });
}));

catalogRouter.put('/questions/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const { topic, body, image, optA, optB, optC, optD, correct, explanation, courseId } = req.body || {};
  if (!body?.trim() || !optA?.trim() || !optB?.trim() || !optC?.trim() || !optD?.trim() || !correct) {
    return fail(res, 400, 'All 4 options, question body, and correct answer are required');
  }
  const upper = String(correct).toUpperCase();
  if (!['A', 'B', 'C', 'D'].includes(upper)) return fail(res, 400, 'Correct option must be A, B, C, or D');

  const [existing] = await sql`SELECT course_id FROM questions WHERE id = ${id}`;
  if (!existing) return fail(res, 404, 'Question not found');
  if (!(await canManageCourse(req.user, existing.course_id))) return fail(res, 403, 'Not your course.');

  const [q] = await sql`
    UPDATE questions
    SET topic = ${topic || null},
        body = ${body.trim()},
        image = ${image || null},
        opt_a = ${optA.trim()},
        opt_b = ${optB.trim()},
        opt_c = ${optC.trim()},
        opt_d = ${optD.trim()},
        correct = ${upper},
        explanation = ${explanation || null},
        course_id = ${courseId ? toInt(courseId) : existing.course_id}
    WHERE id = ${id}
    RETURNING id, course_id AS "courseId", topic, body, image,
              opt_a AS "optA", opt_b AS "optB", opt_c AS "optC", opt_d AS "optD",
              correct, explanation, is_active AS "isActive", created_by AS "createdBy", created_at AS "createdAt"
  `;
  res.json({ success: true, data: q });
}));

catalogRouter.delete('/questions/:id', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const [existing] = await sql`SELECT course_id FROM questions WHERE id = ${id}`;
  if (!existing) return fail(res, 404, 'Question not found');
  if (!(await canManageCourse(req.user, existing.course_id))) return fail(res, 403, 'Not your course.');

  await sql`UPDATE questions SET is_active = FALSE WHERE id = ${id}`;
  res.json({ success: true, data: { id, deleted: true } });
}));

catalogRouter.post('/questions/bulk', asyncHandler(async (req, res) => {
  const { courseId, questions = [] } = req.body || {};
  if (!courseId || !Array.isArray(questions) || questions.length === 0) {
    return fail(res, 400, 'courseId and non-empty questions array are required');
  }
  if (!(await canManageCourse(req.user, courseId))) return fail(res, 403, 'Not your course.');

  const inserted = [];
  for (const item of questions) {
    const { topic, body, image, optA, optB, optC, optD, correct, explanation } = item;
    if (body?.trim() && optA?.trim() && optB?.trim() && optC?.trim() && optD?.trim() && correct) {
      const upper = String(correct).toUpperCase();
      if (['A', 'B', 'C', 'D'].includes(upper)) {
        const [q] = await sql`
          INSERT INTO questions (course_id, topic, body, image, opt_a, opt_b, opt_c, opt_d, correct, explanation, created_by)
          VALUES (${courseId}, ${topic || null}, ${body.trim()}, ${image || null},
                  ${optA.trim()}, ${optB.trim()}, ${optC.trim()}, ${optD.trim()},
                  ${upper}, ${explanation || null}, ${req.user.id})
          RETURNING id, course_id AS "courseId", topic, body, image,
                    opt_a AS "optA", opt_b AS "optB", opt_c AS "optC", opt_d AS "optD",
                    correct, explanation, is_active AS "isActive", created_by AS "createdBy", created_at AS "createdAt"
        `;
        inserted.push(q);
      }
    }
  }

  res.status(201).json({ success: true, data: { count: inserted.length, questions: inserted } });
}));