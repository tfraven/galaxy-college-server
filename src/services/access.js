import { sql } from '../db/connection.js';
import { ROLE } from '../middleware/auth.js';

/** Admin/Operator: any course. Teacher: only assigned courses (FRD permission matrix). */
export const canManageCourse = async (user, courseId) => {
    if (user.role === ROLE.ADMIN || user.role === ROLE.OPERATOR) return true;
    if (user.role !== ROLE.TEACHER) return false;
    const rows = await sql`
    SELECT 1 FROM teacher_courses WHERE user_id = ${user.id} AND course_id = ${courseId} LIMIT 1
  `;
    return rows.length > 0;
};

/** Teacher may schedule/run a class if they are assigned to any course of that class. */
export const canManageClass = async (user, classId) => {
    if (user.role === ROLE.ADMIN || user.role === ROLE.OPERATOR) return true;
    if (user.role !== ROLE.TEACHER) return false;
    const rows = await sql`
    SELECT 1 FROM teacher_courses tc JOIN courses c ON c.id = tc.course_id
    WHERE tc.user_id = ${user.id} AND c.class_id = ${classId} LIMIT 1
  `;
    return rows.length > 0;
};

export const getStudentEnrolment = async (userId) => {
    const [row] = await sql`SELECT class_id, section_id FROM students WHERE user_id = ${userId}`;
    return row || null;
};