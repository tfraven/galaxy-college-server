import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, isStaff, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageClass, getStudentEnrolment } from '../services/access.js';
import { notifyStudents } from '../services/notifications.js';
import { generateVideoSdkToken, sessionIdFromReference, sessionNameFor, sessionReferenceFor } from '../services/zoom.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';

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

// Student payloads only include a public join handle and the details needed to choose a class.
const toStudentDto = (s) => ({
  id: sessionReferenceFor(s.id),
  courseName: s.course_name,
  title: s.title,
  hostName: s.hostname || 'Faculty Instructor',
  planStart: s.plan_start,
  planEnd: s.plan_end,
  status: s.status,
  startedAt: s.started_at,
  endedAt: s.ended_at,
});

const toRecurringDto = (s) => ({
  id: s.id, classId: s.class_id, className: s.classname, sectionId: s.section_id,
  sectionName: s.sectionname || 'All Sections', courseName: s.course_name,
  title: s.title, hostId: s.host_id, hostName: s.hostname || 'Faculty Instructor',
  timezone: s.timezone, weeklySlots: s.weekly_slots, enabled: s.enabled,
});

const normalizeWeeklySlots = (slots) => {
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 21) return null;
  const normalized = [];
  const seen = new Set();
  for (const item of slots) {
    const weekday = Number(item?.weekday);
    const startTime = String(item?.startTime || '');
    const endTime = String(item?.endTime || '');
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
      || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)
      || endTime <= startTime) return null;
    const key = `${weekday}:${startTime}`;
    if (seen.has(key)) return null;
    seen.add(key);
    normalized.push({ weekday, startTime, endTime });
  }
  return normalized;
};

const validateRecurringPayload = async (req, res, payload) => {
  const classId = toInt(payload?.classId);
  const sectionId = payload?.sectionId ? toInt(payload.sectionId) : null;
  const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
  const courseName = typeof payload?.courseName === 'string' ? payload.courseName.trim() : 'General';
  const hostId = payload?.hostId ? toInt(payload.hostId) : null;
  const timezone = typeof payload?.timezone === 'string' ? payload.timezone.trim() : 'Asia/Karachi';
  const weeklySlots = normalizeWeeklySlots(payload?.weeklySlots);
  if (!classId || !title || title.length > 180 || courseName.length > 120 || !weeklySlots) {
    fail(res, 400, 'Class, title, and valid weekly day/time slots are required.');
    return null;
  }
  if ((payload?.sectionId && !sectionId) || (payload?.hostId && !hostId)) {
    fail(res, 400, 'Choose a valid section and instructor.');
    return null;
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); }
  catch { fail(res, 400, 'Choose a valid time zone.'); return null; }
  if (!(await canManageClass(req.user, classId))) {
    fail(res, 403, 'You are not assigned to this class.');
    return null;
  }
  if (sectionId) {
    const [section] = await sql`SELECT 1 FROM sections WHERE id = ${sectionId} AND class_id = ${classId}`;
    if (!section) { fail(res, 400, 'Section does not belong to that class.'); return null; }
  }
  if (hostId) {
    const [host] = await sql`SELECT id FROM users WHERE id = ${hostId} AND role = ${ROLE.TEACHER} AND is_active = TRUE`;
    if (!host || !(await canManageClass({ role: ROLE.TEACHER, id: hostId }, classId))) {
      fail(res, 400, 'Choose an active teacher assigned to this class.');
      return null;
    }
  }
  return { classId, sectionId, title, courseName: courseName || 'General', hostId, timezone, weeklySlots };
};

const fetchSessions = ({ id = null, classId = null, sectionId = null, teacherId = null, pagination = null } = {}) => sql`
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
  ${pagination ? sql`LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}` : sql``}
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
  const pagination = getPagination(req.query);
  let rows;
  let total;
  if (req.user.role === ROLE.STUDENT) {
    const enrol = await getStudentEnrolment(req.user.id);
    if (enrol) {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM live_sessions s
        WHERE s.class_id = ${enrol.class_id} AND (s.section_id IS NULL OR s.section_id = ${enrol.section_id})
          AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')
      `;
      total = count;
      rows = await fetchSessions({ classId: enrol.class_id, sectionId: enrol.section_id, pagination });
    } else {
      total = 0;
      rows = [];
    }
  } else {
    const teacherId = req.user.role === ROLE.TEACHER ? req.user.id : null;
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM live_sessions s
      WHERE (${teacherId}::int IS NULL OR s.host_id = ${teacherId}::int OR s.created_by = ${teacherId}::int OR EXISTS (
        SELECT 1 FROM courses co JOIN teacher_courses tc ON tc.course_id = co.id
        WHERE co.class_id = s.class_id AND tc.user_id = ${teacherId}::int))
    `;
    total = count;
    rows = await fetchSessions({ teacherId, pagination });
  }
  res.json({ success: true, data: rows.map(req.user.role === ROLE.STUDENT ? toStudentDto : toDto), pagination: paginationMeta(total, pagination) });
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
  await notifyStudents({
    type: 'live_scheduled', title: `Live class scheduled: ${row.title}`,
    body: `${row.course_name || 'General'} • ${new Date(row.plan_start).toLocaleString()}`,
    relatedType: 'live_session', relatedId: id, eventKey: `live_scheduled:${id}`,
    classId: row.class_id, sectionId: row.section_id,
  });
  res.status(201).json({ success: true, data: toDto(row) });
}));

sessionsRouter.get('/recurring', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM recurring_live_schedules WHERE deleted_at IS NULL`;
  const rows = await sql`
    SELECT r.id, r.class_id, r.section_id, r.course_name, r.title, r.host_id,
           r.timezone, r.weekly_slots, r.enabled, c.name AS classname,
           sec.name AS sectionname, u.full_name AS hostname
    FROM recurring_live_schedules r
    JOIN classes c ON c.id = r.class_id
    LEFT JOIN sections sec ON sec.id = r.section_id
    LEFT JOIN users u ON u.id = r.host_id
    WHERE r.deleted_at IS NULL
    ORDER BY r.enabled DESC, r.id DESC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data: rows.map(toRecurringDto), pagination: paginationMeta(total, pagination) });
}));

sessionsRouter.post('/recurring', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const values = await validateRecurringPayload(req, res, req.body || {});
  if (!values) return;
  let hostId = values.hostId;
  if (!hostId) {
    const [assignedHost] = await sql`
      SELECT u.id FROM users u JOIN teacher_courses tc ON tc.user_id = u.id
      JOIN courses c ON c.id = tc.course_id
      WHERE u.role = ${ROLE.TEACHER} AND u.is_active = TRUE AND c.class_id = ${values.classId}
      ORDER BY u.id ASC LIMIT 1
    `;
    hostId = assignedHost?.id || null;
  }
  const [row] = await sql`
    INSERT INTO recurring_live_schedules (class_id, section_id, course_name, title, host_id, timezone, weekly_slots, created_by)
    VALUES (${values.classId}, ${values.sectionId}, ${values.courseName}, ${values.title}, ${hostId},
            ${values.timezone}, ${JSON.stringify(values.weeklySlots)}::jsonb, ${req.user.id})
    RETURNING id, class_id, section_id, course_name, title, host_id, timezone, weekly_slots, enabled
  `;
  const [details] = await sql`
    SELECT r.*, c.name AS classname, sec.name AS sectionname, u.full_name AS hostname
    FROM recurring_live_schedules r JOIN classes c ON c.id = r.class_id
    LEFT JOIN sections sec ON sec.id = r.section_id LEFT JOIN users u ON u.id = r.host_id
    WHERE r.id = ${row.id}
  `;
  res.status(201).json({ success: true, data: toRecurringDto(details) });
}));

sessionsRouter.put('/recurring/:id', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Invalid recurring schedule id.');
  const [existing] = await sql`SELECT id FROM recurring_live_schedules WHERE id = ${id} AND deleted_at IS NULL`;
  if (!existing) return fail(res, 404, 'Recurring schedule not found.');
  const values = await validateRecurringPayload(req, res, req.body || {});
  if (!values) return;
  let hostId = values.hostId;
  if (!hostId) {
    const [assignedHost] = await sql`
      SELECT u.id FROM users u JOIN teacher_courses tc ON tc.user_id = u.id
      JOIN courses c ON c.id = tc.course_id
      WHERE u.role = ${ROLE.TEACHER} AND u.is_active = TRUE AND c.class_id = ${values.classId}
      ORDER BY u.id ASC LIMIT 1
    `;
    hostId = assignedHost?.id || null;
  }
  const [row] = await sql`
    UPDATE recurring_live_schedules
    SET class_id = ${values.classId}, section_id = ${values.sectionId}, course_name = ${values.courseName},
        title = ${values.title}, host_id = ${hostId}, timezone = ${values.timezone},
        weekly_slots = ${JSON.stringify(values.weeklySlots)}::jsonb, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `;
  await sql`
    DELETE FROM notifications WHERE related_type = 'live_session' AND related_id IN (
      SELECT id FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()
    )
  `;
  await sql`DELETE FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()`;
  const [details] = await sql`
    SELECT r.*, c.name AS classname, sec.name AS sectionname, u.full_name AS hostname
    FROM recurring_live_schedules r JOIN classes c ON c.id = r.class_id
    LEFT JOIN sections sec ON sec.id = r.section_id LEFT JOIN users u ON u.id = r.host_id
    WHERE r.id = ${row.id}
  `;
  res.json({ success: true, data: toRecurringDto(details) });
}));

sessionsRouter.patch('/recurring/:id/enabled', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id || typeof req.body?.enabled !== 'boolean') return fail(res, 400, 'A schedule id and enabled flag are required.');
  const [row] = await sql`UPDATE recurring_live_schedules SET enabled = ${req.body.enabled}, updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL RETURNING id, enabled`;
  if (!row) return fail(res, 404, 'Recurring schedule not found.');
  if (!row.enabled) {
    await sql`
      DELETE FROM notifications WHERE related_type = 'live_session' AND related_id IN (
        SELECT id FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()
      )
    `;
    await sql`DELETE FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()`;
    await sql`UPDATE live_sessions SET status = 3, ended_at = NOW() WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start <= NOW()`;
  }
  res.json({ success: true, data: row });
}));

sessionsRouter.delete('/recurring/:id', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const id = toInt(req.params.id);
  if (!id) return fail(res, 400, 'Invalid recurring schedule id.');
  await sql`
    DELETE FROM notifications WHERE related_type = 'live_session' AND related_id IN (
      SELECT id FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()
    )
  `;
  await sql`DELETE FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()`;
  await sql`UPDATE live_sessions SET status = 3, ended_at = NOW() WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start <= NOW()`;
  const [deleted] = await sql`UPDATE recurring_live_schedules SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW() WHERE id = ${id} AND deleted_at IS NULL RETURNING id`;
  if (!deleted) return fail(res, 404, 'Recurring schedule not found.');
  res.json({ success: true, data: { id: deleted.id, deleted: true } });
}));

sessionsRouter.get('/hosts', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const classId = req.query.classId === undefined ? null : toInt(req.query.classId);
  if (req.query.classId !== undefined && !classId) return fail(res, 400, 'Invalid class id.');
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`
    SELECT COUNT(*)::int AS total FROM (
      SELECT DISTINCT u.id FROM users u
      WHERE u.role = ${ROLE.TEACHER} AND u.is_active = TRUE
        AND (${classId}::int IS NULL OR EXISTS (
          SELECT 1 FROM teacher_courses tc JOIN courses c ON c.id = tc.course_id
          WHERE tc.user_id = u.id AND c.class_id = ${classId}::int
        ))
    ) hosts
  `;
  const data = await sql`
    SELECT DISTINCT u.id, u.full_name AS "fullName"
    FROM users u
    WHERE u.role = ${ROLE.TEACHER} AND u.is_active = TRUE
      AND (${classId}::int IS NULL OR EXISTS (
        SELECT 1 FROM teacher_courses tc JOIN courses c ON c.id = tc.course_id
        WHERE tc.user_id = u.id AND c.class_id = ${classId}::int
      ))
    ORDER BY u.full_name ASC, u.id ASC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

sessionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const [row] = await fetchSessions({ id });
  res.json({ success: true, data: req.user.role === ROLE.STUDENT ? toStudentDto(row) : toDto(row) });
}));

const NEXT = { 1: [2, 3], 2: [3] }; // Scheduled -> Live | Ended ; Live -> Ended (LIV-3)

sessionsRouter.patch('/:id/status', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
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
  if (status === 2 && access.session.status !== 2) {
    await notifyStudents({
      type: 'live_started', title: `Live class is starting: ${row.title}`,
      body: `${row.course_name || 'General'} is live now.`,
      relatedType: 'live_session', relatedId: id, eventKey: `live_started:${id}`,
      classId: row.class_id, sectionId: row.section_id,
    });
  }
  res.json({ success: true, data: toDto(row) });
}));

/**
 * One call = everything the classroom page needs. Identity and role come from the auth token, so a
 * student can no longer send a teacher's id in the body and get host rights.
 */
sessionsRouter.post('/:id/join-token', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const { session, isHost } = access;

  if (session.status !== 2) return fail(res, 400, 'This class is not live right now.');

  const sessionName = sessionNameFor(session.id);
  const instanceSuffix = Math.random().toString(36).slice(2, 7);
  const { token, expiresAt } = generateVideoSdkToken({
    sessionName,
    isHost,
    userIdentity: `u_${req.user.id}_${instanceSuffix}`,
  });

  res.json({
    success: true,
    data: { token, sessionName, userName: req.user.fullName, isHost, expiresAt },
  });
}));

// LIV-8: record attendance only after Zoom confirms the user actually joined.
sessionsRouter.post('/:id/joined', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
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
  const access = await getAccess(req.user, sessionIdFromReference(req.params.id));
  if (access.error) return fail(res, ...access.error);
  res.json({ success: true, data: { status: access.session.status } });
}));

// LIV-6: staff see who joined.
sessionsRouter.get('/:id/participants', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM session_joins WHERE session_id = ${id}`;
  const data = await sql`
    SELECT u.id AS "userId", u.username AS "rollNo", u.full_name AS "fullName", j.first_join AS "joinedAt"
    FROM session_joins j JOIN users u ON u.id = j.student_id
    WHERE j.session_id = ${id} ORDER BY j.first_join ASC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
  `;
  res.json({ success: true, data, pagination: paginationMeta(total, pagination) });
}));

// Optional app-level chat (LIV-10). Zoom's toolkit has its own chat, so you may delete these.
sessionsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const data = await sql`
    SELECT id, sender_name AS "senderName", sender_role AS "senderRole", message, created_at AS "createdAt"
    FROM session_messages WHERE session_id = ${id} ORDER BY created_at ASC LIMIT 200
  `;
  res.json({ success: true, data });
}));

sessionsRouter.post('/:id/messages', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const message = String(req.body?.message || '').trim();
  if (!message) return fail(res, 400, 'Message cannot be empty');
  if (message.length > 1000) return fail(res, 400, 'Message is too long');
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);

  const [saved] = await sql`
    INSERT INTO session_messages (session_id, user_id, sender_name, sender_role, message)
    VALUES (${id}, ${req.user.id}, ${req.user.fullName}, ${isStaff(req.user) ? 'Faculty' : 'Student'}, ${message})
    RETURNING id, sender_name AS "senderName", sender_role AS "senderRole", message, created_at AS "createdAt"
  `;
  res.status(201).json({ success: true, data: saved });
}));
