import express from 'express';
import { sql } from '../db/connection.js';
import { asyncHandler, fail, isStaff, requireRole, ROLE, STAFF_ROLES, toInt } from '../middleware/auth.js';
import { canManageClass, getStudentEnrolment } from '../services/access.js';
import { notifyStudents } from '../services/notifications.js';
import {
  configuredZoomAccounts, createZoomMeeting, deleteZoomMeeting, generateMeetingSdkToken,
  sessionIdFromReference, sessionReferenceFor, updateZoomMeeting, zoomAccountConfigured,
} from '../services/zoom.js';
import { getPagination, paginationMeta } from '../middleware/pagination.js';
import { runLiveSessionScheduler } from '../services/liveSessionScheduler.js';

export const sessionsRouter = express.Router();

let lastRecurringMaterialization = 0;
let recurringMaterialization = null;
const ensureRecurringSessions = async () => {
  if (Date.now() - lastRecurringMaterialization < 5 * 60_000) return;
  if (!recurringMaterialization) {
    recurringMaterialization = runLiveSessionScheduler()
      .then(() => { lastRecurringMaterialization = Date.now(); })
      .catch((error) => console.warn('[live-scheduler] materialization failed', String(error?.message || error).slice(0, 160)))
      .finally(() => { recurringMaterialization = null; });
  }
  await recurringMaterialization;
};

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
  status: displayedStatus(s),
  startedAt: s.started_at,
  endedAt: s.ended_at,
  participantCount: parseInt(s.participant_count, 10) || 0,
  videoEnabled: s.video_enabled !== false,
  zoomAccount: s.zoom_account || 'account1',
  allowedVideoParticipantIds: (s.video_participant_ids || []).map(Number),
});

// Student payloads only include a public join handle and the details needed to choose a class.
const toStudentDto = (s) => ({
  id: sessionReferenceFor(s.id),
  courseName: s.course_name,
  title: s.title,
  hostName: s.hostname || 'Faculty Instructor',
  planStart: s.plan_start,
  planEnd: s.plan_end,
  status: displayedStatus(s),
  startedAt: s.started_at,
  endedAt: s.ended_at,
});

const toRecurringDto = (s) => ({
  id: s.id, classId: s.class_id, className: s.classname, sectionId: s.section_id,
  sectionName: s.sectionname || 'All Sections', courseName: s.course_name,
  title: s.title, hostId: s.host_id, hostName: s.hostname || 'Faculty Instructor',
  timezone: s.timezone, weeklySlots: s.weekly_slots, enabled: s.enabled,
  zoomAccount: s.zoom_account || 'account1', videoParticipantIds: (s.video_participant_ids || []).map(Number),
});

const isInsideSchedule = (session, now = Date.now()) => {
  const start = new Date(session.plan_start).getTime();
  const end = new Date(session.plan_end).getTime();
  return Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end;
};

const displayedStatus = (session) => {
  if (session.status === 3) return 3;
  if (!isInsideSchedule(session)) return Date.now() >= new Date(session.plan_end).getTime() ? 3 : 1;
  return session.status === 2 || session.recurring_schedule_id ? 2 : 1;
};

const mayJoinNow = (session) => session.status !== 3 && isInsideSchedule(session)
  && (session.status === 2 || Boolean(session.recurring_schedule_id));

const normalizeParticipantIds = (value) => [...new Set((Array.isArray(value) ? value : [])
  .map(toInt).filter((id) => Number.isInteger(id) && id > 0))];

const validateVideoParticipants = async (ids) => {
  if (!ids.length) return true;
  const found = await sql`SELECT id FROM users WHERE id = ANY(${ids}::int[]) AND role = ${ROLE.VIDEO_PARTICIPANT} AND is_active = TRUE`;
  return found.length === ids.length;
};

const setSessionVideoParticipants = async (sessionId, userIds, createdBy) => {
  await sql.transaction([
    sql`DELETE FROM video_participant_sessions WHERE session_id = ${sessionId}`,
    ...(userIds.length ? [sql`
      INSERT INTO video_participant_sessions (session_id, user_id, created_by)
      SELECT ${sessionId}, value, ${createdBy} FROM unnest(${userIds}::int[]) AS value
      ON CONFLICT DO NOTHING
    `] : []),
  ]);
};

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
  const zoomAccount = ['account1', 'account2'].includes(payload?.zoomAccount) ? payload.zoomAccount : 'account1';
  const videoParticipantIds = req.user.role === ROLE.ADMIN
    ? normalizeParticipantIds(payload?.videoParticipantIds)
    : [];
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
  if (!zoomAccountConfigured(zoomAccount)) {
    fail(res, 503, `Configure ${zoomAccount === 'account2' ? 'Zoom account 2' : 'Zoom account 1'} before using this schedule.`);
    return null;
  }
  if (!(await validateVideoParticipants(videoParticipantIds))) {
    fail(res, 400, 'Only active video-session participant accounts can be allowed.');
    return null;
  }
  if (hostId) {
    const [host] = await sql`SELECT id FROM users WHERE id = ${hostId} AND role = ${ROLE.TEACHER} AND is_active = TRUE`;
    if (!host || !(await canManageClass({ role: ROLE.TEACHER, id: hostId }, classId))) {
      fail(res, 400, 'Choose an active teacher assigned to this class.');
      return null;
    }
  }
  return { classId, sectionId, title, courseName: courseName || 'General', hostId, timezone, weeklySlots, zoomAccount, videoParticipantIds };
};

const fetchSessions = ({ id = null, classId = null, sectionId = null, teacherId = null, pagination = null } = {}) => sql`
  SELECT s.id, s.class_id, s.section_id, s.course_name, s.title, s.host_id, s.video_enabled, s.plan_start, s.plan_end,
         s.zoom_account, s.recurring_schedule_id,
         s.status, s.started_at, s.ended_at, s.created_by,
         c.name AS classname, sec.name AS sectionname, u.full_name AS hostname,
         ARRAY(SELECT vps.user_id FROM video_participant_sessions vps WHERE vps.session_id = s.id ORDER BY vps.user_id) AS video_participant_ids,
         (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) AS participant_count
  FROM live_sessions s
  JOIN classes c ON s.class_id = c.id
  LEFT JOIN sections sec ON s.section_id = sec.id
  LEFT JOIN users u ON s.host_id = u.id
  WHERE (${id}::int IS NULL OR s.id = ${id}::int)
    AND s.deleted_at IS NULL
    AND (${classId}::int IS NULL OR (
          s.class_id = ${classId}::int
          AND (s.section_id IS NULL OR s.section_id = ${sectionId}::int)
          AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')))
    AND (${teacherId}::int IS NULL OR s.host_id = ${teacherId}::int OR s.created_by = ${teacherId}::int OR EXISTS (
          SELECT 1 FROM courses co JOIN teacher_courses tc ON tc.course_id = co.id
          WHERE co.class_id = s.class_id AND tc.user_id = ${teacherId}::int))
  ORDER BY s.status ASC, s.plan_start ASC
  LIMIT ${pagination?.pageSize ?? 1} OFFSET ${pagination?.offset ?? 0}
`;

/**
 * Single source of truth for "may this user be in this session, and as what?" (LIV-3 / LIV-4).
 * Used by join-token, live-status, participants and chat so the rules cannot drift apart.
 */
const getAccess = async (user, sessionId) => {
  const [session] = await sql`SELECT * FROM live_sessions WHERE id = ${sessionId}`;
  if (!session || session.deleted_at) return { error: [404, 'Session not found'] };

  if (isStaff(user)) {
    const manages = user.role !== ROLE.TEACHER || user.id === session.host_id || (await canManageClass(user, session.class_id));
    if (!manages) return { error: [403, 'You are not assigned to this class.'] };
    return { session, isHost: true };
  }

  if (user.role === ROLE.VIDEO_PARTICIPANT) {
    if (!session.video_enabled) return { error: [403, 'Video participants are not enabled for this class.'] };
    const [allowed] = await sql`
      SELECT 1 FROM video_participant_sessions WHERE session_id = ${sessionId} AND user_id = ${user.id}
    `;
    if (!allowed) return { error: [403, 'This video participant account is not allowed in this session.'] };
    return { session, isHost: false };
  }

  const enrol = await getStudentEnrolment(user.id);
  const allowed = enrol && enrol.class_id === session.class_id && (!session.section_id || enrol.section_id === session.section_id);
  if (!allowed) return { error: [403, 'This class is not for your section.'] };
  return { session, isHost: false };
};

sessionsRouter.get('/', asyncHandler(async (req, res) => {
  await ensureRecurringSessions();
  const pagination = getPagination(req.query);
  let rows;
  let total;
  if (req.user.role === ROLE.STUDENT) {
    const enrol = await getStudentEnrolment(req.user.id);
    if (enrol) {
      const [{ count }] = await sql`
        SELECT COUNT(*)::int AS count FROM live_sessions s
        WHERE s.class_id = ${enrol.class_id} AND (s.section_id IS NULL OR s.section_id = ${enrol.section_id})
          AND s.deleted_at IS NULL AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')
      `;
      total = count;
      rows = await fetchSessions({ classId: enrol.class_id, sectionId: enrol.section_id, pagination });
    } else {
      total = 0;
      rows = [];
    }
  } else if (req.user.role === ROLE.VIDEO_PARTICIPANT) {
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM live_sessions s
      JOIN video_participant_sessions vps ON vps.session_id = s.id AND vps.user_id = ${req.user.id}
      WHERE s.video_enabled = TRUE AND s.deleted_at IS NULL AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')
    `;
    total = count;
    rows = await sql`
      SELECT s.id, s.class_id, s.section_id, s.course_name, s.title, s.host_id, s.plan_start, s.plan_end,
             s.zoom_account, s.recurring_schedule_id,
             s.status, s.started_at, s.ended_at, s.created_by, s.video_enabled,
             c.name AS classname, sec.name AS sectionname, u.full_name AS hostname,
             ARRAY(SELECT p.user_id FROM video_participant_sessions p WHERE p.session_id = s.id ORDER BY p.user_id) AS video_participant_ids,
             (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) AS participant_count
      FROM live_sessions s JOIN classes c ON c.id = s.class_id
      LEFT JOIN sections sec ON sec.id = s.section_id LEFT JOIN users u ON u.id = s.host_id
      JOIN video_participant_sessions vps ON vps.session_id = s.id AND vps.user_id = ${req.user.id}
      WHERE s.video_enabled = TRUE AND s.deleted_at IS NULL AND (s.status < 3 OR s.ended_at > NOW() - INTERVAL '1 day')
      ORDER BY s.status ASC, s.plan_start ASC LIMIT ${pagination.pageSize} OFFSET ${pagination.offset}
    `;
  } else {
    const teacherId = req.user.role === ROLE.TEACHER ? req.user.id : null;
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count FROM live_sessions s
      WHERE s.deleted_at IS NULL AND (${teacherId}::int IS NULL OR s.host_id = ${teacherId}::int OR s.created_by = ${teacherId}::int OR EXISTS (
        SELECT 1 FROM courses co JOIN teacher_courses tc ON tc.course_id = co.id
        WHERE co.class_id = s.class_id AND tc.user_id = ${teacherId}::int))
    `;
    total = count;
    rows = await fetchSessions({ teacherId, pagination });
  }
  const publicViewer = req.user.role === ROLE.STUDENT || req.user.role === ROLE.VIDEO_PARTICIPANT;
  res.json({ success: true, data: rows.map(publicViewer ? toStudentDto : toDto), pagination: paginationMeta(total, pagination) });
}));

// LIV-1: schedule. No Zoom link/ID needed: the room is derived from the session id.
sessionsRouter.post('/', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const { classId, sectionId, courseName, title, hostId, planStart, planEnd, videoEnabled = true } = req.body || {};
  if (!classId || !title?.trim()) return fail(res, 400, 'Class and title are required');
  if (!(await canManageClass(req.user, classId))) return fail(res, 403, 'You are not assigned to this class.');
  const videoParticipantIds = req.user.role === ROLE.ADMIN
    ? normalizeParticipantIds(req.body?.videoParticipantIds)
    : [];
  if (videoEnabled && !(await validateVideoParticipants(videoParticipantIds))) {
    return fail(res, 400, 'Only active video-session participant accounts can be allowed.');
  }

  if (sectionId) {
    const [sec] = await sql`SELECT 1 FROM sections WHERE id = ${sectionId} AND class_id = ${classId}`;
    if (!sec) return fail(res, 400, 'Section does not belong to that class');
  }

  const now = new Date();
  const start = planStart ? new Date(planStart) : now;
  const end = planEnd ? new Date(planEnd) : new Date(start.getTime() + 90 * 60000);
  if (isNaN(start) || isNaN(end) || end <= start) return fail(res, 400, 'End time must be after start time');

  const zoomAccount = ['account1', 'account2'].includes(req.body?.zoomAccount) ? req.body.zoomAccount : 'account1';
  if (videoEnabled && !zoomAccountConfigured(zoomAccount)) {
    return fail(res, 503, `Configure ${zoomAccount === 'account2' ? 'Zoom account 2' : 'Zoom account 1'} before scheduling a video class.`);
  }

  // A teacher hosts their own session; Admin/Operator may nominate a host.
  const finalHost = req.user.role === ROLE.TEACHER ? req.user.id : hostId || null;

  let zoomMeeting = null;
  if (videoEnabled) {
    try {
      zoomMeeting = await createZoomMeeting(zoomAccount, { title, planStart: start, planEnd: end });
    } catch (error) {
      return fail(res, error.status || 502, error.message || 'Could not create the Zoom meeting.');
    }
  }

  const [{ id }] = await sql`
    INSERT INTO live_sessions (class_id, section_id, course_name, title, host_id, plan_start, plan_end, status, created_by, video_enabled,
                               zoom_account, zoom_meeting_id, zoom_passcode, zoom_join_url)
    VALUES (${classId}, ${sectionId || null}, ${courseName || 'General'}, ${title.trim()}, ${finalHost},
            ${start.toISOString()}, ${end.toISOString()}, 1, ${req.user.id}, ${Boolean(videoEnabled)}, ${zoomAccount},
            ${zoomMeeting?.meetingId || null}, ${zoomMeeting?.passcode || null}, ${zoomMeeting?.joinUrl || null})
    RETURNING id
  `;
  await setSessionVideoParticipants(id, videoEnabled ? videoParticipantIds : [], req.user.id);
  const [row] = await fetchSessions({ id });
  await notifyStudents({
    type: 'live_scheduled', title: `Live class scheduled: ${row.title}`,
    body: `${row.course_name || 'General'} • ${new Date(row.plan_start).toLocaleString()}`,
    relatedType: 'live_session', relatedId: id, eventKey: `live_scheduled:${id}`,
    classId: row.class_id, sectionId: row.section_id,
  });
  res.status(201).json({ success: true, data: toDto(row) });
}));

sessionsRouter.get('/zoom-accounts', requireRole(...STAFF_ROLES), (_req, res) => {
  res.json({ success: true, data: configuredZoomAccounts() });
});

sessionsRouter.get('/video-participants', requireRole(ROLE.ADMIN), asyncHandler(async (_req, res) => {
  const data = await sql`
    SELECT id, username, full_name AS "fullName"
    FROM users WHERE role = ${ROLE.VIDEO_PARTICIPANT} AND is_active = TRUE
    ORDER BY full_name, id
  `;
  res.json({ success: true, data });
}));

sessionsRouter.get('/recurring', requireRole(ROLE.ADMIN, ROLE.OPERATOR), asyncHandler(async (req, res) => {
  const pagination = getPagination(req.query);
  const [{ total }] = await sql`SELECT COUNT(*)::int AS total FROM recurring_live_schedules WHERE deleted_at IS NULL`;
  const rows = await sql`
    SELECT r.id, r.class_id, r.section_id, r.course_name, r.title, r.host_id,
           r.timezone, r.weekly_slots, r.enabled, r.zoom_account, c.name AS classname,
           sec.name AS sectionname, u.full_name AS hostname
           , ARRAY(SELECT rvp.user_id FROM recurring_video_participants rvp WHERE rvp.schedule_id = r.id ORDER BY rvp.user_id) AS video_participant_ids
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
    INSERT INTO recurring_live_schedules (class_id, section_id, course_name, title, host_id, timezone, weekly_slots, zoom_account, created_by)
    VALUES (${values.classId}, ${values.sectionId}, ${values.courseName}, ${values.title}, ${hostId},
            ${values.timezone}, ${JSON.stringify(values.weeklySlots)}::jsonb, ${values.zoomAccount}, ${req.user.id})
    RETURNING id, class_id, section_id, course_name, title, host_id, timezone, weekly_slots, enabled
  `;
  if (values.videoParticipantIds.length) {
    await sql`
      INSERT INTO recurring_video_participants (schedule_id, user_id)
      SELECT ${row.id}, value FROM unnest(${values.videoParticipantIds}::int[]) AS value ON CONFLICT DO NOTHING
    `;
  }
  const [details] = await sql`
    SELECT r.*, c.name AS classname, sec.name AS sectionname, u.full_name AS hostname,
           ARRAY(SELECT rvp.user_id FROM recurring_video_participants rvp WHERE rvp.schedule_id = r.id ORDER BY rvp.user_id) AS video_participant_ids
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
        weekly_slots = ${JSON.stringify(values.weeklySlots)}::jsonb, zoom_account = ${values.zoomAccount}, updated_at = NOW()
    WHERE id = ${id}
    RETURNING id
  `;
  if (req.user.role === ROLE.ADMIN) {
    await sql.transaction([
      sql`DELETE FROM recurring_video_participants WHERE schedule_id = ${id}`,
      ...(values.videoParticipantIds.length ? [sql`
        INSERT INTO recurring_video_participants (schedule_id, user_id)
        SELECT ${id}, value FROM unnest(${values.videoParticipantIds}::int[]) AS value ON CONFLICT DO NOTHING
      `] : []),
    ]);
  }
  await sql`
    DELETE FROM notifications WHERE related_type = 'live_session' AND related_id IN (
      SELECT id FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()
    )
  `;
  await sql`DELETE FROM live_sessions WHERE recurring_schedule_id = ${id} AND status = 1 AND plan_start > NOW()`;
  const [details] = await sql`
    SELECT r.*, c.name AS classname, sec.name AS sectionname, u.full_name AS hostname,
           ARRAY(SELECT rvp.user_id FROM recurring_video_participants rvp WHERE rvp.schedule_id = r.id ORDER BY rvp.user_id) AS video_participant_ids
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
  const publicViewer = req.user.role === ROLE.STUDENT || req.user.role === ROLE.VIDEO_PARTICIPANT;
  res.json({ success: true, data: publicViewer ? toStudentDto(row) : toDto(row) });
}));

sessionsRouter.put('/:id', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const old = access.session;
  const title = typeof req.body?.title === 'string' ? req.body.title.trim() : old.title;
  const courseName = typeof req.body?.courseName === 'string' ? req.body.courseName.trim() : old.course_name || 'General';
  const start = req.body?.planStart ? new Date(req.body.planStart) : new Date(old.plan_start);
  const end = req.body?.planEnd ? new Date(req.body.planEnd) : new Date(old.plan_end);
  const videoEnabled = typeof req.body?.videoEnabled === 'boolean' ? req.body.videoEnabled : old.video_enabled !== false;
  const zoomAccount = ['account1', 'account2'].includes(req.body?.zoomAccount) ? req.body.zoomAccount : old.zoom_account || 'account1';
  if (!title || title.length > 180 || courseName.length > 120 || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return fail(res, 400, 'Provide a valid session title, subject, start time, and end time.');
  }
  if (videoEnabled && !zoomAccountConfigured(zoomAccount)) {
    return fail(res, 503, `Configure ${zoomAccount === 'account2' ? 'Zoom account 2' : 'Zoom account 1'} before saving this video class.`);
  }

  const participantIds = req.body?.videoParticipantIds === undefined
    ? (await sql`SELECT user_id FROM video_participant_sessions WHERE session_id = ${id}`).map((row) => row.user_id)
    : normalizeParticipantIds(req.body.videoParticipantIds);
  if (!videoEnabled && participantIds.length) return fail(res, 400, 'Disable video participants before turning off video for this session.');
  if (!(await validateVideoParticipants(participantIds))) return fail(res, 400, 'Only active video-session participant accounts can be allowed.');

  let meeting = null;
  try {
    if (videoEnabled) {
      if (old.zoom_meeting_id && (old.zoom_account || 'account1') === zoomAccount) {
        await updateZoomMeeting(zoomAccount, old.zoom_meeting_id, { title, planStart: start, planEnd: end });
        meeting = { meetingId: old.zoom_meeting_id, passcode: old.zoom_passcode || '', joinUrl: old.zoom_join_url || '' };
      } else {
        meeting = await createZoomMeeting(zoomAccount, { title, planStart: start, planEnd: end });
      }
    }
  } catch (error) {
    return fail(res, error.status || 502, error.message || 'Could not update the Zoom meeting.');
  }

  await sql`
    UPDATE live_sessions SET title = ${title}, course_name = ${courseName}, plan_start = ${start.toISOString()}, plan_end = ${end.toISOString()},
      video_enabled = ${videoEnabled}, zoom_account = ${zoomAccount}, zoom_meeting_id = ${meeting?.meetingId || null},
      zoom_passcode = ${meeting?.passcode || null}, zoom_join_url = ${meeting?.joinUrl || null}
    WHERE id = ${id}
  `;
  await setSessionVideoParticipants(id, videoEnabled ? participantIds : [], req.user.id);
  if (old.zoom_meeting_id && (!videoEnabled || (old.zoom_account || 'account1') !== zoomAccount)) {
    void deleteZoomMeeting(old.zoom_account || 'account1', old.zoom_meeting_id).catch(() => {});
  }
  const [row] = await fetchSessions({ id });
  res.json({ success: true, data: toDto(row) });
}));

const NEXT = { 1: [2, 3], 2: [3] }; // Scheduled -> Live | Ended ; Live -> Ended (LIV-3)

sessionsRouter.patch('/:id/status', requireRole(...STAFF_ROLES), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const status = toInt(req.body?.status);
  if (![1, 2, 3].includes(status)) return fail(res, 400, 'Status must be 1, 2 or 3');

  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  if (status === 3) {
    if (req.user.role !== ROLE.ADMIN) return fail(res, 403, 'Only an administrator can end a live session.');
    if (req.body?.confirmTitle !== access.session.title) return fail(res, 400, 'Type the exact session name to confirm ending it.');
  }
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

sessionsRouter.delete('/:id', requireRole(ROLE.ADMIN), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  if (req.body?.confirmTitle !== access.session.title) return fail(res, 400, 'Type the exact session name to confirm deleting it.');
  await sql`UPDATE live_sessions SET status = 3, ended_at = COALESCE(ended_at, NOW()), deleted_at = NOW() WHERE id = ${id}`;
  await sql`DELETE FROM notifications WHERE related_type = 'live_session' AND related_id = ${id}`;
  res.json({ success: true, data: { id, deleted: true } });
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

  if (!mayJoinNow(session)) return fail(res, 400, 'This class is outside its scheduled join time.');
  if (!session.zoom_meeting_id) return fail(res, 503, 'This live session does not have Zoom Meeting details yet.');
  const { signature, zak, expiresAt } = await generateMeetingSdkToken({
    accountKey: session.zoom_account || 'account1',
    meetingNumber: session.zoom_meeting_id,
    isHost,
  });

  res.json({
    success: true,
    data: { signature, meetingNumber: session.zoom_meeting_id, password: session.zoom_passcode || '', zak, userName: req.user.fullName, isHost, expiresAt },
  });
}));

// LIV-8: record attendance only after Zoom confirms the user actually joined.
sessionsRouter.post('/:id/joined', asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  if (!mayJoinNow(access.session)) return fail(res, 400, 'This class is outside its scheduled join time.');

  if (req.user.role === ROLE.STUDENT) {
    await sql`INSERT INTO session_joins (session_id, student_id) VALUES (${id}, ${req.user.id}) ON CONFLICT DO NOTHING`;
  }
  res.json({ success: true, data: { joined: true } });
}));

// Lightweight poll used by classroom.html so students are dropped when the class is ended (LIV-7).
sessionsRouter.get('/:id/live-status', asyncHandler(async (req, res) => {
  const access = await getAccess(req.user, sessionIdFromReference(req.params.id));
  if (access.error) return fail(res, ...access.error);
  res.json({ success: true, data: { status: displayedStatus(access.session) } });
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
sessionsRouter.get('/:id/messages', requireRole(ROLE.ADMIN, ROLE.OPERATOR, ROLE.TEACHER, ROLE.STUDENT), asyncHandler(async (req, res) => {
  const id = sessionIdFromReference(req.params.id);
  const access = await getAccess(req.user, id);
  if (access.error) return fail(res, ...access.error);
  const data = await sql`
    SELECT id, sender_name AS "senderName", sender_role AS "senderRole", message, created_at AS "createdAt"
    FROM session_messages WHERE session_id = ${id} ORDER BY created_at ASC LIMIT 200
  `;
  res.json({ success: true, data });
}));

sessionsRouter.post('/:id/messages', requireRole(ROLE.ADMIN, ROLE.OPERATOR, ROLE.TEACHER, ROLE.STUDENT), asyncHandler(async (req, res) => {
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
