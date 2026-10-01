import express from 'express';
import { sql } from '../db/connection.js';
import { generateVideoSdkToken, sessionNameFor } from '../services/zoom.js';

export const sessionsRouter = express.Router();

const STAFF_ROLES = [1, 2, 3]; // Admin, Operator, Teacher

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
  participantCount: parseInt(s.participant_count) || 0,
});

sessionsRouter.get('/', async (_req, res) => {
  try {
    const sessions = await sql`
      SELECT
        s.id, s.class_id, s.section_id, s.course_name, s.title,
        s.host_id, s.plan_start, s.plan_end, s.status, s.started_at, s.ended_at,
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

// Create a session. No Zoom link/ID needed: the Zoom room is derived from the session id.
sessionsRouter.post('/', async (req, res) => {
  try {
    const { classId, sectionId, courseName, title, hostId, planStart, planEnd, status = 1 } = req.body;

    if (!classId || !title || !title.trim()) {
      return res.status(400).json({ success: false, error: 'Class and title are required' });
    }

    const now = new Date();
    const finalStart = planStart || now.toISOString();
    const finalEnd = planEnd || new Date(now.getTime() + 90 * 60 * 1000).toISOString();

    const [created] = await sql`
      INSERT INTO live_sessions (
        class_id, section_id, course_name, title, host_id, plan_start, plan_end, status, created_by
      )
      VALUES (
        ${classId}, ${sectionId || null}, ${courseName || 'General'}, ${title.trim()}, ${hostId || null},
        ${finalStart}, ${finalEnd}, ${status}, ${hostId || null}
      )
      RETURNING id
    `;

    const rows = await sql`
      SELECT
        s.id, s.class_id, s.section_id, s.course_name, s.title,
        s.host_id, s.plan_start, s.plan_end, s.status, s.started_at, s.ended_at,
        c.name as className, sec.name as sectionName, u.full_name as hostName,
        0 as participant_count
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN users u ON s.host_id = u.id
      WHERE s.id = ${created.id}
    `;

    return res.status(201).json({ success: true, data: buildSessionDto(rows[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

sessionsRouter.patch('/:id/status', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (![1, 2, 3].includes(status)) {
      return res.status(400).json({ success: false, error: 'Status must be 1, 2 or 3' });
    }

    const now = new Date().toISOString();
    if (status === 2) {
      await sql`UPDATE live_sessions SET status = ${status}, started_at = ${now} WHERE id = ${sessionId}`;
    } else if (status === 3) {
      await sql`UPDATE live_sessions SET status = ${status}, ended_at = ${now} WHERE id = ${sessionId}`;
    } else {
      await sql`UPDATE live_sessions SET status = ${status} WHERE id = ${sessionId}`;
    }

    const rows = await sql`
      SELECT
        s.id, s.class_id, s.section_id, s.course_name, s.title,
        s.host_id, s.plan_start, s.plan_end, s.status, s.started_at, s.ended_at,
        c.name as className, sec.name as sectionName, u.full_name as hostName,
        (SELECT COUNT(*)::int FROM session_joins WHERE session_id = s.id) as participant_count
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN users u ON s.host_id = u.id
      WHERE s.id = ${sessionId}
    `;
    if (!rows[0]) return res.status(404).json({ success: false, error: 'Session not found' });

    return res.json({ success: true, data: buildSessionDto(rows[0]) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// One call = everything the app needs to enter the class. Nothing for the user to type, copy or paste.
sessionsRouter.post('/:id/join-token', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    // TODO: take the user from your auth middleware (req.user.id) instead of trusting the body.
    // As written, anyone who sends a teacher's id gets host rights.
    const userId = req.user?.id ?? req.body.userId ?? req.body.studentId;
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Please sign in again.' });
    }

    const [session] = await sql`SELECT * FROM live_sessions WHERE id = ${sessionId}`;
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (session.status !== 2) {
      return res.status(400).json({ success: false, error: 'This class is not live right now.' });
    }

    const [user] = await sql`SELECT id, role, full_name FROM users WHERE id = ${userId} AND is_active = TRUE`;
    if (!user) return res.status(401).json({ success: false, error: 'User not found.' });

    const isHost = STAFF_ROLES.includes(user.role) || user.id === session.host_id;

    if (!isHost) {
      // Students may only enter their own class (and section, if the session is section-specific).
      const [enrol] = await sql`SELECT class_id, section_id FROM students WHERE user_id = ${user.id}`;
      const allowed =
        enrol &&
        enrol.class_id === session.class_id &&
        (!session.section_id || enrol.section_id === session.section_id);
      if (!allowed) {
        return res.status(403).json({ success: false, error: 'This class is not for your section.' });
      }

      await sql`
        INSERT INTO session_joins (session_id, student_id)
        VALUES (${sessionId}, ${user.id})
        ON CONFLICT (session_id, student_id) DO NOTHING
      `;
    }

    const sessionName = sessionNameFor(session.id);
    const { token, expiresAt } = generateVideoSdkToken({
      sessionName,
      isHost,
      userIdentity: `user_${user.id}`,
    });

    return res.json({
      success: true,
      data: {
        token,
        sessionName,
        sessionTitle: session.title,
        userName: user.full_name,
        isHost,
        expiresAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Optional: your own chat endpoints. Zoom's UI already has chat, so you can delete these if you don't want two.
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

sessionsRouter.post('/:id/messages', async (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { userId, message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, error: 'Message cannot be empty' });
    }
    const [u] = userId ? await sql`SELECT full_name, role FROM users WHERE id = ${userId}` : [];
    if (!u) return res.status(401).json({ success: false, error: 'User not found' });

    const [saved] = await sql`
      INSERT INTO session_messages (session_id, user_id, sender_name, sender_role, message)
      VALUES (${sessionId}, ${userId}, ${u.full_name}, ${STAFF_ROLES.includes(u.role) ? 'Faculty' : 'Student'}, ${message.trim()})
      RETURNING id, session_id as "sessionId", user_id as "userId",
                sender_name as "senderName", sender_role as "senderRole",
                message, created_at as "createdAt"
    `;
    return res.status(201).json({ success: true, data: saved });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});