import express from 'express';
import { db } from '../db/connection.js';
import { generateZoomSessionToken } from '../services/zoom.js';

export const sessionsRouter = express.Router();

sessionsRouter.get('/', (_req, res) => {
  try {
    const sessions = db.prepare(`
      SELECT 
        s.id,
        s.class_id as classId,
        c.name as className,
        s.section_id as sectionId,
        sec.name as sectionName,
        s.course_name as courseName,
        s.title,
        s.host_id as hostId,
        u.full_name as hostName,
        s.plan_start as planStart,
        s.plan_end as planEnd,
        s.status,
        s.started_at as startedAt,
        s.ended_at as endedAt,
        s.zoom_session_id as zoomSessionId,
        (SELECT COUNT(*) FROM session_joins WHERE session_id = s.id) as participantCount
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN sections sec ON s.section_id = sec.id
      LEFT JOIN users u ON s.host_id = u.id
      ORDER BY s.status ASC, s.plan_start ASC
    `).all();

    return res.json({ success: true, data: sessions });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

sessionsRouter.post('/', (req, res) => {
  try {
    const {
      classId,
      sectionId,
      courseName,
      title,
      hostId,
      planStart,
      planEnd,
      status = 1,
    } = req.body;

    if (!classId || !title) {
      return res.status(400).json({ success: false, error: 'Class and title are required' });
    }

    const now = new Date();
    const finalStart = planStart || now.toISOString();
    const finalEnd = planEnd || new Date(now.getTime() + 90 * 60 * 1000).toISOString();
    const zoomSessionId = `zoom_session_${Date.now()}`;

    const result = db.prepare(`
      INSERT INTO live_sessions (
        class_id, section_id, course_name, title, host_id,
        plan_start, plan_end, status, zoom_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      classId,
      sectionId || null,
      courseName || 'General',
      title.trim(),
      hostId || null,
      finalStart,
      finalEnd,
      status,
      zoomSessionId
    );

    const sessionId = result.lastInsertRowid;
    const cls = db.prepare('SELECT name FROM classes WHERE id = ?').get(classId);
    const host = hostId ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(hostId) : null;

    return res.status(201).json({
      success: true,
      data: {
        id: sessionId,
        classId,
        className: cls ? cls.name : '',
        sectionId: sectionId || null,
        sectionName: 'All Sections',
        courseName: courseName || 'General',
        title: title.trim(),
        hostId,
        hostName: host ? host.full_name : 'Faculty Instructor',
        planStart: finalStart,
        planEnd: finalEnd,
        status,
        participantCount: 0,
        zoomSessionId,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

sessionsRouter.patch('/:id/status', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (status === undefined) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const now = new Date().toISOString();
    if (status === 2) {
      db.prepare('UPDATE live_sessions SET status = ?, started_at = ? WHERE id = ?').run(status, now, sessionId);
    } else if (status === 3) {
      db.prepare('UPDATE live_sessions SET status = ?, ended_at = ? WHERE id = ?').run(status, now, sessionId);
    } else {
      db.prepare('UPDATE live_sessions SET status = ? WHERE id = ?').run(status, sessionId);
    }

    const session = db.prepare(`
      SELECT 
        s.id,
        s.class_id as classId,
        c.name as className,
        s.section_id as sectionId,
        s.course_name as courseName,
        s.title,
        s.host_id as hostId,
        u.full_name as hostName,
        s.plan_start as planStart,
        s.plan_end as planEnd,
        s.status,
        s.started_at as startedAt,
        s.ended_at as endedAt,
        s.zoom_session_id as zoomSessionId,
        (SELECT COUNT(*) FROM session_joins WHERE session_id = s.id) as participantCount
      FROM live_sessions s
      JOIN classes c ON s.class_id = c.id
      LEFT JOIN users u ON s.host_id = u.id
      WHERE s.id = ?
    `).get(sessionId);

    return res.json({ success: true, data: session });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LIV-4: Issue Zoom Video SDK JWT token and record join
sessionsRouter.post('/:id/join-token', (req, res) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const { studentId } = req.body;

    const session = db.prepare('SELECT * FROM live_sessions WHERE id = ?').get(sessionId);
    if (!session) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }

    if (session.status !== 2) {
      return res.status(400).json({ success: false, error: 'This class session is not currently live' });
    }

    let user = null;
    let isHost = false;
    if (studentId) {
      user = db.prepare('SELECT id, role, full_name, username FROM users WHERE id = ?').get(studentId);
      if (user && (user.role === 1 || user.role === 2 || user.id === session.host_id)) {
        isHost = true;
      }
    }

    // Record attendance / join event
    if (studentId) {
      try {
        db.prepare('INSERT OR IGNORE INTO session_joins (session_id, student_id) VALUES (?, ?)').run(sessionId, studentId);
      } catch (e) {
        // Ignore duplicate joins
      }
    }

    const sessionName = `class_room_${session.id}_${session.zoom_session_id || 'stream'}`;
    const displayName = user ? user.full_name : `Student_${studentId || 'Guest'}`;

    // Generate Zoom Video SDK JWT token with audio and camera allowed for students
    const zoomTokenData = generateZoomSessionToken({
      sessionName,
      roleType: isHost ? 1 : 0, // 1: Host/Teacher, 0: Student Participant
      userIdentity: displayName,
      sessionKey: session.zoom_session_pwd || '',
    });

    return res.json({
      success: true,
      data: {
        token: zoomTokenData.token,
        roomName: sessionName,
        sessionTitle: session.title,
        zoomSessionId: session.zoom_session_id,
        canTalk: true,       // Audio unmute allowed
        canShareVideo: true, // Camera allowed
        role: zoomTokenData.userRole,
        expiresAt: zoomTokenData.expiresAt,
        isConfigured: zoomTokenData.isRealZoomCredentialsConfigured,
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});
