import express from 'express';
import { sql } from '../db/connection.js';
import { generateZoomSessionToken, resolveZoomMeetingDetails } from '../services/zoom.js';

export const sessionsRouter = express.Router();

const buildSessionDto = (s) => ({
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
  zoomSessionId: s.zoom_session_id,
  zoomMeetingId: s.zoom_meeting_id,
  zoomPasscode: s.zoom_passcode,
  zoomJoinUrl: s.zoom_join_url,
  participantCount: parseInt(s.participant_count) || 0,
});

sessionsRouter.get('/', async (_req, res) => {
  try {
    const sessions = await sql`
      SELECT
        s.id, s.class_id, s.section_id, s.course_name, s.title,
        s.host_id, s.plan_start, s.plan_end, s.status,
        s.started_at, s.ended_at, s.zoom_session_id,
        s.zoom_meeting_id, s.zoom_passcode, s.zoom_join_url,
        c.name as className,
        sec.name as sectionName,
        u.full_name as hostName,
        (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) as participant_count
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN users u ON s.host_id = u.id
      ORDER BY s.status ASC, s.plan_start ASC
    `;

    return res.json({ success: true, data: sessions.map(buildSessionDto) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

sessionsRouter.post('/', async (req, res) => {
  try {
    const {
      classId, sectionId, courseName, title, hostId,
      planStart, planEnd, status = 1,
      zoomJoinUrl, zoomMeetingId, zoomPasscode,
    } = req.body;

    if (!classId || !title) {
      return res.status(400).json({ success: false, error: 'Class and title are required' });
    }

    const now = new Date();
    const finalStart = planStart || now.toISOString();
    const finalEnd = planEnd || new Date(now.getTime() + 90 * 60 * 1000).toISOString();
    const zoomSessionId = `zoom_session_${Date.now()}`;

    // Resolve or generate clean Zoom meeting credentials
    const resolvedMeeting = resolveZoomMeetingDetails({
      sessionId: Date.now() % 10000000,
      customUrl: zoomJoinUrl,
      customMeetingId: zoomMeetingId,
      customPasscode: zoomPasscode,
    });

    const [newSession] = await sql`
      INSERT INTO live_sessions (
        class_id, section_id, course_name, title, host_id,
        plan_start, plan_end, status, zoom_session_id,
        zoom_meeting_id, zoom_passcode, zoom_join_url
      )
      VALUES (
        ${classId}, ${sectionId || null}, ${courseName || 'General'}, ${title.trim()}, ${hostId || null},
        ${finalStart}, ${finalEnd}, ${status}, ${zoomSessionId},
        ${resolvedMeeting.meetingId}, ${resolvedMeeting.passcode}, ${resolvedMeeting.zoomUrl}
      )
      RETURNING id
    `;

    const sessionId = newSession.id;
    const clsRows = await sql`SELECT name FROM classes WHERE id = ${classId}`;
    let hostRows = [];
    if (hostId) {
      hostRows = await sql`SELECT full_name FROM users WHERE id = ${hostId}`;
    }

    return res.status(201).json({
      success: true,
      data: {
        id: sessionId,
        classId,
        className: clsRows[0]?.name || '',
        sectionId: sectionId || null,
        sectionName: 'All Sections',
        courseName: courseName || 'General',
        title: title.trim(),
        hostId,
        hostName: hostRows[0]?.full_name || 'Faculty Instructor',
        planStart: finalStart,
        planEnd: finalEnd,
        status,
        participantCount: 0,
        zoomSessionId,
        zoomMeetingId: resolvedMeeting.meetingId,
        zoomPasscode: resolvedMeeting.passcode,
        zoomJoinUrl: resolvedMeeting.zoomUrl,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

sessionsRouter.patch('/:id/status', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const now = new Date().toISOString();
    if (status === 2) {
      await sql`UPDATE live_sessions SET status = ${status}, started_at = ${now} WHERE id = ${sessionId}`;
    } else if (status === 3) {
      await sql`UPDATE live_sessions SET status = ${status}, ended_at = ${now} WHERE id = ${sessionId}`;
    } else {
      await sql`UPDATE live_sessions SET status = ${status} WHERE id = ${sessionId}`;
    }

    const sessions = await sql`
      SELECT
        s.id, s.class_id, s.section_id, s.course_name, s.title,
        s.host_id, s.plan_start, s.plan_end, s.status,
        s.started_at, s.ended_at, s.zoom_session_id,
        s.zoom_meeting_id, s.zoom_passcode, s.zoom_join_url,
        c.name as className,
        sec.name as sectionName,
        u.full_name as hostName,
        (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) as participant_count
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN users u ON s.host_id = u.id
      WHERE s.id = ${sessionId}
    `;

    return res.json({ success: true, data: buildSessionDto(sessions[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LIV-4: Issue Zoom Video SDK JWT token and Zoom Meeting Details
sessionsRouter.post('/:id/join-token', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { studentId, userId } = req.body;
    const participantId = userId || studentId;

    const sessionRows = await sql`SELECT * FROM live_sessions WHERE id = ${sessionId}`;
    const session = sessionRows[0];
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status !== 2) {
      return res.status(400).json({ success: false, error: 'This class session is not currently live' });
    }

    let user = null;
    let isHost = false;
    if (participantId) {
      const userRows = await sql`SELECT id, role, full_name, username FROM users WHERE id = ${participantId}`;
      user = userRows[0];
      if (user && (user.role === 1 || user.role === 2 || user.role === 3 || user.id === session.host_id)) {
        isHost = true;
      }
    }

    // Record attendance / join event for students
    if (participantId && !isHost) {
      await sql`
        INSERT INTO session_joins (session_id, student_id)
        VALUES (${sessionId}, ${participantId})
        ON CONFLICT (session_id, student_id) DO NOTHING
      `;
    }

    const sessionName = `class_room_${session.id}_${session.zoom_session_id || 'stream'}`;
    const displayName = user ? user.full_name : `Student_${participantId || 'Guest'}`;

    // Generate Zoom Video SDK token
    const zoomTokenData = generateZoomSessionToken({
      sessionName,
      roleType: isHost ? 1 : 0,
      userIdentity: displayName,
      sessionKey: session.zoom_session_pwd || '',
    });

    // Resolve Zoom Meeting info (App deep link, official Web Client URL, meeting ID, passcode)
    const resolvedMeeting = resolveZoomMeetingDetails({
      sessionId: session.id,
      customUrl: session.zoom_join_url,
      customMeetingId: session.zoom_meeting_id,
      customPasscode: session.zoom_passcode,
      displayName,
      isHost,
    });

    return res.json({
      success: true,
      data: {
        token: zoomTokenData.token,
        roomName: sessionName,
        sessionTitle: session.title,
        zoomSessionId: session.zoom_session_id,
        meetingId: resolvedMeeting.meetingId,
        passcode: resolvedMeeting.passcode,
        zoomUrl: resolvedMeeting.zoomUrl,
        zoomAppUrl: resolvedMeeting.zoomAppUrl,
        webClientUrl: resolvedMeeting.webClientUrl,
        hasValidMeeting: resolvedMeeting.hasValidMeeting,
        canTalk: true,
        canShareVideo: true,
        role: zoomTokenData.userRole,
        isHost,
        userName: displayName,
        expiresAt: zoomTokenData.expiresAt,
        isConfigured: zoomTokenData.isRealZoomCredentialsConfigured,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LIV-4B: Update Zoom meeting link for a session
sessionsRouter.patch('/:id/zoom-link', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { zoomJoinUrl } = req.body;
    if (!zoomJoinUrl || !zoomJoinUrl.trim()) {
      return res.status(400).json({ success: false, error: 'Zoom meeting link is required' });
    }

    const resolved = resolveZoomMeetingDetails({
      sessionId,
      customUrl: zoomJoinUrl.trim(),
    });

    if (!resolved.hasValidMeeting) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a valid Zoom meeting link (e.g., https://zoom.us/j/1234567890?pwd=... or a 9-11 digit Meeting ID).',
      });
    }

    await sql`
      UPDATE live_sessions
      SET zoom_join_url = ${zoomJoinUrl.trim()},
          zoom_meeting_id = ${resolved.meetingId},
          zoom_passcode = ${resolved.passcode}
      WHERE id = ${sessionId}
    `;

    return res.json({
      success: true,
      data: {
        sessionId,
        zoomJoinUrl: zoomJoinUrl.trim(),
        meetingId: resolved.meetingId,
        passcode: resolved.passcode,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LIV-5: Get live class messages
sessionsRouter.get('/:id/messages', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const messages = await sql`
      SELECT id, session_id as "sessionId", user_id as "userId",
             sender_name as "senderName", sender_role as "senderRole",
             message, created_at as "createdAt"
      FROM session_messages
      WHERE session_id = ${sessionId}
      ORDER BY created_at ASC
      LIMIT 200
    `;
    return res.json({ success: true, data: messages });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LIV-6: Post a live class chat message
sessionsRouter.post('/:id/messages', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { userId, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty' });
    }

    let senderName = 'Class Member';
    let senderRole = 'Student';

    if (userId) {
      const userRows = await sql`SELECT full_name, role FROM users WHERE id = ${userId}`;
      if (userRows[0]) {
        senderName = userRows[0].full_name;
        senderRole = (userRows[0].role === 1 || userRows[0].role === 2 || userRows[0].role === 3) ? 'Faculty' : 'Student';
      }
    }

    const [saved] = await sql`
      INSERT INTO session_messages (session_id, user_id, sender_name, sender_role, message)
      VALUES (${sessionId}, ${userId || 1}, ${senderName}, ${senderRole}, ${message.trim()})
      RETURNING id, session_id as "sessionId", user_id as "userId",
                sender_name as "senderName", sender_role as "senderRole",
                message, created_at as "createdAt"
    `;

    return res.status(201).json({ success: true, data: saved });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
