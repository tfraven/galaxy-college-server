import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, isStaff, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageClass, getStudentEnrolment } from '../services/access.js';
import { generateVideoSdkToken, sessionNameFor } from '../services/zoom.js';

export const sessionsRouter = express.Router();

const toDto = (s) => ({
  id: s.id,
  classId: s.class_id,
  className: s.classname,
  sectionId: s.section_id,
  sectionName: s.sectionname || 'All Sections',
  courseName: s.course_name,
  title: s.title,
  hostId: s.host_id,
  hostName: s.hostname || 'Faculty Instructor',
  planStart: s.plan_start,
  planEnd: s.plan_end,
  status: s.status,
  startedAt: s.started_at,
  endedAt: s.ended_at,
  participantCount: parseInt(s.participant_count, 10) || 0,
});

const fetchSessions = ({ id = null, classId = null, sectionId = null, teacherId = null } = {}) => sql`
  SELECT s.id, s.class_id, s.section_id, s.course_name, s.title, s.host_id, s.plan_start, s.plan_end,
         s.status, s.started_at, s.ended_at, s.created_by,
         c.name AS classname, sec.name AS sectionname, u.full_name AS hostname,
         (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) AS participant_count
  FROM live_sessions s
  JOIN classes c ON s.class_id = c.id
  LEFT JOIN sections sec ON s.section_id = sec.id
  LEFT JOIN users u ON s.host_id = u.id
  WHERE (${id}::int IS NULL OR s.id = ${id}::int)
    AND (${classId}::int IS NULL OR (
          s.class_id = ${classId}::int
          AND (s.section_id IS NULL OR s.section_id = ${sectionId}::int)
          AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')))
    AND (${teacherId}::int IS NULL OR s.host_id = ${teacherId}::int OR s.created_by = ${teacherId}::int OR EXISTS (
          SELECT 1 FROM courses co JOIN teacher_courses tc ON tc.course_id = co.id
          WHERE co.class_id = s.class_id AND tc.user_id = ${teacherId}::int))
  ORDER BY s.status ASC, s.plan_start ASC
`;

/**
 * Single source of truth for "may this user be in this session, and as what?" (LIV-3 / LIV-4).
 * Used by join-token, live-status, participants and chat so the rules cannot drift apart.
 */
const getAccess = async (user, sessionId) => {
  const [session] = await sql`SELECT * FROM live_sessions WHERE id = ${sessionId}`;
  if (!session) return { error: [404, 'Session not found'] };

  if (isStaff(user)) {
    const manages = user.role !== ROLE.TEACHER || user.id === session.host_id || (await canManageClass(user, session.class_id));
    if (!manages) return { error: [403, 'You are not assigned to this class.'] };
    return { session, isHost: true };
  }

  const enrol = await getStudentEnrolment(user.id);
  const allowed = enrol && enrol.class_id === session.class_id && (!session.section_id || enrol.section_id === session.section_id);
  if (!allowed) return { error: [403, 'This class is not for your section.'] };
  return { session, isHost: false };
};

sessionsRouter.get('/', asyncHandler(async (req, res) => {
  let rows;
  if (req.user.role === ROLE.STUDENT) {
    const enrol = await getStudentEnrolment(req.user.id);
    rows = enrol ? await fetchSessions({ classId: enrol.class_id, sectionId: enrol.section_id }) : [];
  } else {
    rows = await fetchSessions({ teacherId: req.user.role === ROLE.TEACHER ? req.user.id : null });
  }
  res.json({ success: true, data: rows.map(toDto) });
}));

// LIV-1: schedule. No Zoom link/ID needed: the room is derived from the session id.
sessionsRouter.post('/', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const { classId, sectionId, courseName, title, hostId, planStart, planEnd } = req.body || {};
  if (!classId || !title?.trim()) return fail(res, 400, 'Class and title are required');
  if (!(await canManageClass(req.user, classId))) return fail(res, 403, 'You are not assigned to this class.');

  if (sectionId) {
    const [sec] = await sql`SELECT 1 FROM sections WHERE id = ${sectionId} AND class_id = ${classId}`;
    if (!sec) return fail(res, 400, 'Section does not belong to that class');
  }

  const now = new Date();
  const start = planStart ? new Date(planStart) : now;
  const end = planEnd ? new Date(planEnd) : new Date(start.getTime() + 90 * 60000);
  if (isNaN(start) || isNaN(end) || end <= start) return fail(res, 400, 'End time must be after start time');

  // A teacher hosts their own session; Admin/Operator may nominate a host.
  const finalHost = req.user.role === ROLE.TEACHER ? req.user.id : hostId || null;

  const [{ id }] = await sql`
    INSERT INTO live_sessions (class_id, section_id, course_name, title, host_id, plan_start, plan_end, status, created_by)
    VALUES (${classId}, ${sectionId || null}, ${courseName || 'General'}, ${title.trim()}, ${finalHost},
            ${start.toISOString()}, ${end.toISOString()}, 1, ${req.user.id})
    RETURNING id
  `;
  const [row] = await fetchSessions({ id });
  res.status(201).json({ success: true, data: toDto(row) });
}));

const NEXT = { 1: [2, 3], 2: [3] }; // Scheduled -> Live | Ended ; Live -> Ended (LIV-3)

sessionsRouter.patch('/:id/status', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const status = toInt(req.body?.status);
  if (![1, 2, 3].includes(status)) return fail(res, 400, 'Status must be 1, 2 or 3');

  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  if (status !== access.session.status && !NEXT[access.session.status]?.includes(status)) {
    return fail(res, 400, 'A class can go Scheduled -> Live -> Ended, and an ended class cannot be reopened.');
  }

  if (status === 2) await sql`UPDATE live_sessions SET status = 2, started_at = COALESCE(started_at, NOW()) WHERE id = ${id}`;
  else if (status === 3) await sql`UPDATE live_sessions SET status = 3, ended_at = NOW() WHERE id = ${id}`;

  const [row] = await fetchSessions({ id });
  res.json({ success: true, data: toDto(row) });
}));

/**
 * One call = everything the classroom page needs. Identity and role come from the auth token, so a
 * student can no longer send a teacher's id in the body and get host rights.
 */
sessionsRouter.post('/:id/join-token', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const { session, isHost } = access;

  if (session.status !== 2) return fail(res, 400, 'This class is not live right now.');

  const sessionName = sessionNameFor(session.id);
  const { token, expiresAt } = generateVideoSdkToken({ sessionName, isHost, userIdentity: `user_${req.user.id}` });

  res.json({
    success: true,
    data: { token, sessionName, sessionTitle: session.title, userName: req.user.fullName, isHost, expiresAt, sessionId: session.id },
  });
}));

// LIV-8: record attendance only after Zoom confirms the user actually joined.
sessionsRouter.post('/:id/joined', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  if (access.session.status !== 2) return fail(res, 400, 'This class is not live right now.');

  if (!access.isHost) {
    await sql`INSERT INTO session_joins (session_id, student_id) VALUES (${id}, ${req.user.id}) ON CONFLICT DO NOTHING`;
  }
  res.json({ success: true, data: { joined: true } });
}));

// Lightweight poll used by classroom.html so students are dropped when the class is ended (LIV-7).
sessionsRouter.get('/:id/live-status', asyncHandler(async (req, res) => {
  const access = await getAccess(req.user, toInt(req.params.id));
  if (access.error) return fail(res, ...access.error);
  res.json({ success: true, data: { status: access.session.status } });
}));

// LIV-6: staff see who joined.
sessionsRouter.get('/:id/participants', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const data = await sql`
    SELECT u.id AS "userId", u.username AS "rollNo", u.full_name AS "fullName", j.first_join AS "firstJoin"
    FROM session_joins j JOIN users u ON u.id = j.student_id
    WHERE j.session_id = ${id} ORDER BY j.first_join ASC
  `;
  res.json({ success: true, data });
}));

// Optional app-level chat (LIV-10). Zoom's toolkit has its own chat, so you may delete these.
sessionsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const data = await sql`
    SELECT id, session_id AS "sessionId", user_id AS "userId", sender_name AS "senderName",
           sender_role AS "senderRole", message, created_at AS "createdAt"
    FROM session_messages WHERE session_id = ${id} ORDER BY created_at ASC LIMIT 200
  `;
  res.json({ success: true, data });
}));

sessionsRouter.post('/:id/messages', asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  const message = String(req.body?.message || '').trim();
  if (!message) return fail(res, 400, 'Message cannot be empty');
  if (message.length > 1000) return fail(res, 400, 'Message is too long');
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);

  const [saved] = await sql`
    INSERT INTO session_messages (session_id, user_id, sender_name, sender_role, message)
    VALUES (${id}, ${req.user.id}, ${req.user.fullName}, ${isStaff(req.user) ? 'Faculty' : 'Student'}, ${message})
    RETURNING id, session_id AS "sessionId", user_id AS "userId", sender_name AS "senderName",
              sender_role AS "senderRole", message, created_at AS "createdAt"
  `;
  res.status(201).json({ success: true, data: saved });
}));
